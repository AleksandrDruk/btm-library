import { base64ToBytes, bytesToBase64 } from './crypto.js';

export const VISUAL_FINGERPRINT_VERSION = 1;
export const VISUAL_SAMPLE_SIZE = 16;

const CHANNELS_PER_PIXEL = 3;
const QUANTIZED_CHANNEL_COUNT = VISUAL_SAMPLE_SIZE * VISUAL_SAMPLE_SIZE * CHANNELS_PER_PIXEL;
const PACKED_BYTE_COUNT = QUANTIZED_CHANNEL_COUNT / 2;
const BASE64_LENGTH = 512;
const MAX_ASPECT_RATIO_DELTA = 0.02;
const MAX_RMS_CHANNEL_DELTA = 1;
const MAX_NORMAL_CHANNEL_DELTA = 2;
const MAX_OUTLIER_CHANNEL_DELTA = 4;
const MAX_OUTLIER_RMS_CHANNEL_DELTA = 0.35;

function fail(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function normalizedPixels(value) {
  if (!(value instanceof Uint8ClampedArray) && !(value instanceof Uint8Array)) {
    fail('Visual fingerprint expects RGBA bytes.');
  }
  if (value.byteLength !== VISUAL_SAMPLE_SIZE * VISUAL_SAMPLE_SIZE * 4) {
    fail('Visual fingerprint received an unexpected sample size.');
  }
  return value;
}

function quantizeChannel(value) {
  return Math.round(value / 17);
}

function packedChannels(rgba) {
  const packed = new Uint8Array(PACKED_BYTE_COUNT);
  let channelIndex = 0;
  let packedIndex = 0;
  for (let pixelIndex = 0; pixelIndex < VISUAL_SAMPLE_SIZE * VISUAL_SAMPLE_SIZE; pixelIndex += 1) {
    const sourceOffset = pixelIndex * 4;
    for (let channel = 0; channel < CHANNELS_PER_PIXEL; channel += 1) {
      const quantized = quantizeChannel(rgba[sourceOffset + channel]);
      if (channelIndex % 2 === 0) {
        packed[packedIndex] = quantized << 4;
      } else {
        packed[packedIndex] |= quantized;
        packedIndex += 1;
      }
      channelIndex += 1;
    }
  }
  return packed;
}

function unpackChannels(value) {
  let packed;
  try {
    packed = base64ToBytes(value);
  } catch {
    fail('Visual fingerprint data is not valid base64.');
  }
  if (packed.byteLength !== PACKED_BYTE_COUNT) {
    fail('Visual fingerprint data has an unexpected length.');
  }
  const channels = new Uint8Array(QUANTIZED_CHANNEL_COUNT);
  for (let index = 0; index < packed.length; index += 1) {
    channels[index * 2] = packed[index] >> 4;
    channels[index * 2 + 1] = packed[index] & 0x0f;
  }
  return channels;
}

export function validateVisualFingerprint(value) {
  if (!isPlainObject(value)) {
    fail('Visual fingerprint must be an object.');
  }
  const keys = Object.keys(value).sort();
  if (keys.join(',') !== 'aspect_ratio,data,version') {
    fail('Visual fingerprint fields do not match version 1.');
  }
  if (value.version !== VISUAL_FINGERPRINT_VERSION) {
    fail('Visual fingerprint version is unsupported.');
  }
  if (!Number.isFinite(value.aspect_ratio) || value.aspect_ratio < 0.05 || value.aspect_ratio > 20) {
    fail('Visual fingerprint aspect ratio is invalid.');
  }
  if (
    typeof value.data !== 'string'
    || value.data.length !== BASE64_LENGTH
    || !/^[A-Za-z0-9+/]+$/.test(value.data)
  ) {
    fail('Visual fingerprint data has an invalid format.');
  }
  unpackChannels(value.data);
  return {
    version: VISUAL_FINGERPRINT_VERSION,
    aspect_ratio: Number(value.aspect_ratio.toFixed(6)),
    data: value.data,
  };
}

export function createVisualFingerprint(rgba, aspectRatio) {
  const pixels = normalizedPixels(rgba);
  if (!Number.isFinite(aspectRatio) || aspectRatio <= 0) {
    fail('Visual fingerprint expects a positive aspect ratio.');
  }
  return validateVisualFingerprint({
    version: VISUAL_FINGERPRINT_VERSION,
    aspect_ratio: Number(aspectRatio.toFixed(6)),
    data: bytesToBase64(packedChannels(pixels)),
  });
}

export function compareVisualFingerprints(left, right) {
  const normalizedLeft = validateVisualFingerprint(left);
  const normalizedRight = validateVisualFingerprint(right);
  const leftChannels = unpackChannels(normalizedLeft.data);
  const rightChannels = unpackChannels(normalizedRight.data);
  const aspectRatioDelta = Math.abs(normalizedLeft.aspect_ratio - normalizedRight.aspect_ratio)
    / Math.max(normalizedLeft.aspect_ratio, normalizedRight.aspect_ratio);
  let squaredDelta = 0;
  let maximumDelta = 0;
  for (let index = 0; index < leftChannels.length; index += 1) {
    const delta = Math.abs(leftChannels[index] - rightChannels[index]);
    squaredDelta += delta * delta;
    maximumDelta = Math.max(maximumDelta, delta);
  }
  const rmsChannelDelta = Math.sqrt(squaredDelta / leftChannels.length);
  const channelNoiseMatches = maximumDelta <= MAX_NORMAL_CHANNEL_DELTA
    || (
      maximumDelta <= MAX_OUTLIER_CHANNEL_DELTA
      && rmsChannelDelta <= MAX_OUTLIER_RMS_CHANNEL_DELTA
    );
  return {
    match: aspectRatioDelta <= MAX_ASPECT_RATIO_DELTA
      && rmsChannelDelta <= MAX_RMS_CHANNEL_DELTA
      && channelNoiseMatches,
    aspect_ratio_delta: aspectRatioDelta,
    rms_channel_delta: rmsChannelDelta,
    max_channel_delta: maximumDelta,
  };
}

export function visualFingerprintsMatch(left, right) {
  return compareVisualFingerprints(left, right).match;
}
