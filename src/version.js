import packageMetadata from '../package.json' with { type: 'json' };

export const GITPIGEON_VERSION = packageMetadata.version;
export const IS_STANDALONE = typeof __GITPIGEON_STANDALONE__ === 'boolean'
  ? __GITPIGEON_STANDALONE__
  : process.env.GITPIGEON_STANDALONE === '1';
