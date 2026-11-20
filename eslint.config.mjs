const browser = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', location: 'readonly',
  localStorage: 'readonly', console: 'readonly', fetch: 'readonly', performance: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  requestAnimationFrame: 'readonly', cancelAnimationFrame: 'readonly', queueMicrotask: 'readonly',
  Blob: 'readonly', File: 'readonly', FileReader: 'readonly', FormData: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', Response: 'readonly', Request: 'readonly',
  Headers: 'readonly', AbortController: 'readonly', ReadableStream: 'readonly',
  TextDecoder: 'readonly', TextEncoder: 'readonly', Audio: 'readonly', Image: 'readonly',
  Event: 'readonly', CustomEvent: 'readonly', DataTransfer: 'readonly',
  SpeechSynthesisUtterance: 'readonly', speechSynthesis: 'readonly', matchMedia: 'readonly',
  getComputedStyle: 'readonly', MutationObserver: 'readonly', ResizeObserver: 'readonly',
  Intl: 'readonly', Intl_: 'readonly', structuredClone: 'readonly', crypto: 'readonly',
  atob: 'readonly', btoa: 'readonly', module: 'writable', globalThis: 'readonly'
};

const node = {
  process: 'readonly', Buffer: 'readonly', __dirname: 'readonly', __filename: 'readonly',
  require: 'readonly', module: 'writable', exports: 'writable', console: 'readonly',
  setTimeout: 'readonly', clearTimeout: 'readonly', setInterval: 'readonly', clearInterval: 'readonly',
  URL: 'readonly', URLSearchParams: 'readonly', TextDecoder: 'readonly', TextEncoder: 'readonly',
  fetch: 'readonly', Response: 'readonly', ReadableStream: 'readonly', performance: 'readonly',
  Blob: 'readonly', AbortController: 'readonly', structuredClone: 'readonly', queueMicrotask: 'readonly'
};

export default [
  { ignores: ['_build/**', 'node_modules/**', 'index.html'] },
  {
    files: ['_src/app.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: browser
    },
    rules: {
      'no-undef': 'error',
      'no-redeclare': 'error',
      'no-dupe-keys': 'error',
      'no-unreachable': 'error',
      'no-const-assign': 'error',
      'no-fallthrough': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }]
    }
  },
  {
    files: ['_src/**/*.mjs', 'eslint.config.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: { ...node }
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }]
    }
  }
];
