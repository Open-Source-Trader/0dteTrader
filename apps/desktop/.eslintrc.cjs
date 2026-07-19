module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  parserOptions: { ecmaVersion: 2021, sourceType: 'module', ecmaFeatures: { jsx: true } },
  plugins: ['@typescript-eslint', 'react-hooks', 'react-refresh'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { browser: true, es2021: true },
  ignorePatterns: ['dist/', 'node_modules/', 'electron/'],
  rules: {
    '@typescript-eslint/no-explicit-any': 'off',
    '@typescript-eslint/no-unused-vars': [
      'error',
      {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        destructuredArrayIgnorePattern: '^_',
        ignoreRestSiblings: true,
      },
    ],
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
    'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
  },
};
