module.exports = {
  root: true,
  env: {
    node: true,
    jest: true
  },
  extends: [
    'plugin:vue/strongly-recommended',
    'standard'
  ],
  rules: {
    'max-len': 0,
    'no-debugger': process.env.NODE_ENV === 'production' ? 'error' : 'warn',
    'no-unused-vars': process.env.NODE_ENV === 'production' ? 'error' : 'warn',
    'quote-props': 'off',
    'accessor-pairs': 'warn',
    'vue/html-closing-bracket-newline': process.env.NODE_ENV === 'production'
      ? 'off'
      : [
          'error', {
            singleline: 'never',
            multiline: 'always'
          }
        ]
  },
  parserOptions: {
    parser: 'babel-eslint'
  }
}
