export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGE_SIDE = 6000;
export const MAX_IMAGE_PIXELS = 16_000_000;

export class ImageValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ImageValidationError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new ImageValidationError(code, message);
}

function bytesFrom(value) {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }
  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }
  fail('invalid_binary', 'Не удалось прочитать изображение.');
}

function ascii(bytes, start, length) {
  let output = '';
  for (let index = start; index < start + length && index < bytes.length; index += 1) {
    output += String.fromCharCode(bytes[index]);
  }
  return output;
}

function inspectPng(bytes) {
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  if (bytes.length < 45 || !signature.every((byte, index) => bytes[index] === byte)) {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let position = 8;
  let width = 0;
  let height = 0;
  let sawIdat = false;
  let sawIend = false;
  let chunkIndex = 0;

  while (position + 12 <= bytes.length) {
    const length = view.getUint32(position, false);
    const type = ascii(bytes, position + 4, 4);
    const dataStart = position + 8;
    const next = dataStart + length + 4;
    if (next > bytes.length) {
      fail('invalid_png', 'PNG содержит обрезанный chunk.');
    }

    if (chunkIndex === 0) {
      if (type !== 'IHDR' || length !== 13) {
        fail('invalid_png', 'PNG не содержит корректный IHDR.');
      }
      width = view.getUint32(dataStart, false);
      height = view.getUint32(dataStart + 4, false);
    } else if (type === 'IHDR') {
      fail('invalid_png', 'PNG содержит повторный IHDR.');
    }

    if (type === 'IDAT') {
      sawIdat = true;
    }
    if (type === 'IEND') {
      if (length !== 0 || next !== bytes.length) {
        fail('invalid_png', 'PNG содержит некорректный IEND или данные после него.');
      }
      sawIend = true;
      break;
    }

    position = next;
    chunkIndex += 1;
  }

  if (!sawIdat || !sawIend) {
    fail('invalid_png', 'PNG не содержит полный набор IDAT/IEND.');
  }

  return {
    mime: 'image/png',
    extension: 'png',
    width,
    height,
  };
}

function inspectJpeg(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return null;
  }

  const sofMarkers = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf]);
  let position = 2;
  let dimensions = null;

  while (position + 3 < bytes.length) {
    while (position < bytes.length && bytes[position] !== 0xff) {
      position += 1;
    }
    while (position < bytes.length && bytes[position] === 0xff) {
      position += 1;
    }
    if (position >= bytes.length) {
      break;
    }

    const marker = bytes[position];
    position += 1;
    if (marker === 0xd9) {
      fail('invalid_jpeg', 'JPEG завершился до данных изображения.');
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) {
      continue;
    }
    if (position + 1 >= bytes.length) {
      break;
    }

    const length = (bytes[position] << 8) | bytes[position + 1];
    if (length < 2 || position + length > bytes.length) {
      fail('invalid_jpeg', 'JPEG содержит повреждённый сегмент.');
    }

    if (sofMarkers.has(marker)) {
      if (length < 7) {
        fail('invalid_jpeg', 'JPEG содержит повреждённый SOF-сегмент.');
      }
      dimensions = {
        mime: 'image/jpeg',
        extension: 'jpg',
        width: (bytes[position + 5] << 8) | bytes[position + 6],
        height: (bytes[position + 3] << 8) | bytes[position + 4],
      };
    }

    if (marker === 0xda) {
      if (!dimensions) {
        fail('invalid_jpeg', 'JPEG не содержит SOF до данных изображения.');
      }
      const scanStart = position + length;
      for (let index = scanStart; index + 1 < bytes.length; index += 1) {
        if (bytes[index] === 0xff && bytes[index + 1] === 0xd9) {
          return dimensions;
        }
      }
      fail('invalid_jpeg', 'JPEG не содержит завершающий EOI.');
    }

    position += length;
  }

  fail('invalid_jpeg', 'Не удалось определить размер JPEG.');
}

function inspectWebp(bytes) {
  if (bytes.length < 30 || ascii(bytes, 0, 4) !== 'RIFF' || ascii(bytes, 8, 4) !== 'WEBP') {
    return null;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const declaredLength = view.getUint32(4, true) + 8;
  if (declaredLength !== bytes.length) {
    fail('invalid_webp', 'Размер RIFF не совпадает с размером WebP-файла.');
  }

  let position = 12;
  let dimensions = null;
  while (position + 8 <= bytes.length) {
    const chunk = ascii(bytes, position, 4);
    const chunkLength = view.getUint32(position + 4, true);
    const dataStart = position + 8;
    const dataEnd = dataStart + chunkLength;
    const next = dataEnd + (chunkLength % 2);
    if (dataEnd > bytes.length || next > bytes.length) {
      fail('invalid_webp', 'WebP содержит обрезанный chunk.');
    }

    if (chunk === 'VP8X' && chunkLength >= 10) {
      dimensions = {
        mime: 'image/webp',
        extension: 'webp',
        width: 1 + bytes[dataStart + 4] + (bytes[dataStart + 5] << 8) + (bytes[dataStart + 6] << 16),
        height: 1 + bytes[dataStart + 7] + (bytes[dataStart + 8] << 8) + (bytes[dataStart + 9] << 16),
      };
    } else if (chunk === 'VP8L' && chunkLength >= 5 && bytes[dataStart] === 0x2f) {
      dimensions = {
        mime: 'image/webp',
        extension: 'webp',
        width: 1 + bytes[dataStart + 1] + ((bytes[dataStart + 2] & 0x3f) << 8),
        height: 1 + (bytes[dataStart + 2] >> 6) + (bytes[dataStart + 3] << 2) + ((bytes[dataStart + 4] & 0x0f) << 10),
      };
    } else if (
      chunk === 'VP8 '
      && chunkLength >= 10
      && bytes[dataStart + 3] === 0x9d
      && bytes[dataStart + 4] === 0x01
      && bytes[dataStart + 5] === 0x2a
    ) {
      dimensions = {
        mime: 'image/webp',
        extension: 'webp',
        width: (bytes[dataStart + 6] | (bytes[dataStart + 7] << 8)) & 0x3fff,
        height: (bytes[dataStart + 8] | (bytes[dataStart + 9] << 8)) & 0x3fff,
      };
    }

    position = next;
  }

  if (position !== bytes.length || !dimensions) {
    fail('invalid_webp', 'Не удалось проверить структуру и размер WebP.');
  }
  return dimensions;
}

export function inspectImage(value) {
  const bytes = bytesFrom(value);
  if (bytes.byteLength < 1) {
    fail('empty_file', 'Файл пустой.');
  }
  if (bytes.byteLength > MAX_IMAGE_BYTES) {
    fail('file_too_large', 'Размер файла превышает 10 МБ.');
  }

  const prefix = ascii(bytes, 0, Math.min(bytes.length, 120));
  if (prefix.startsWith('version https://git-lfs.github.com/spec/')) {
    fail('git_lfs_pointer', 'Git LFS pointer не является изображением.');
  }

  const result = inspectPng(bytes) || inspectJpeg(bytes) || inspectWebp(bytes);
  if (!result) {
    fail('unsupported_image', 'Файл не является поддерживаемым JPEG, PNG или WebP.');
  }

  if (!Number.isInteger(result.width) || !Number.isInteger(result.height) || result.width < 1 || result.height < 1) {
    fail('invalid_dimensions', 'Не удалось определить корректные размеры изображения.');
  }
  if (result.width > MAX_IMAGE_SIDE || result.height > MAX_IMAGE_SIDE) {
    fail('image_too_wide', `Максимальная сторона изображения — ${MAX_IMAGE_SIDE}px.`);
  }
  if (result.width * result.height > MAX_IMAGE_PIXELS) {
    fail('image_too_many_pixels', 'Изображение превышает лимит 16 миллионов пикселей.');
  }

  return {
    ...result,
    bytes: bytes.byteLength,
  };
}
