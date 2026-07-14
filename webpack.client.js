const path = require('path');
const HtmlPlugin = require('html-webpack-plugin');

module.exports = {
  mode: process.env.NODE_ENV === 'development' ? 'development' : 'production',
  target: 'electron-renderer',
  entry: './src/client/index.tsx',
  output: {
    path: path.resolve(__dirname, 'dist/client'),
    filename: 'bundle.js',
  },
  resolve: {
    extensions: ['.ts', '.tsx', '.js'],
  },
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        use: {
          loader: 'ts-loader',
          options: { configFile: 'tsconfig.renderer.json' },
        },
        exclude: /node_modules/,
      },
    ],
  },
  plugins: [
    new HtmlPlugin({
      template: './src/client/index.html',
      filename: 'index.html',
    }),
  ],
};