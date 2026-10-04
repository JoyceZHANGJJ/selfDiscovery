/*
 * Eslint config file
 * Documentation: https://eslint.org/docs/user-guide/configuring/
 * Install the Eslint extension before using this feature.
 */
module.exports = {
  env: {
    es6: true,
    browser: true,
    node: true,
  },
  ecmaFeatures: {
    modules: true,
  },
  parserOptions: {
    ecmaVersion: 2018,
    sourceType: 'module',
  },
  globals: {
    wx: true,
    App: true,
    Page: true,
    getCurrentPages: true,
    getApp: true,
    Component: true,
    requirePlugin: true,
    requireMiniProgram: true,
  },
  // 不开 eslintrc:recommended（规则太多、噪声大），只开最能拦住事故的那几条：
  // no-undef 能拦住「module.exports 里写了没定义的名字」——那类错误只在运行时炸（整页空白），
  // 之前 lint 形同虚设（extends 被注释、rules 为空），就是这么漏过去的。
  rules: {
    'no-undef': 'error',
    'no-dupe-keys': 'error',
    'no-unreachable': 'error',
    'no-sparse-arrays': 'error',
    'no-constant-condition': 'warn',
    'no-unused-vars': 'warn'
  },
}
