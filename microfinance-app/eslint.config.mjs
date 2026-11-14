// ESLint 9 flat config. eslint-config-next 15.x still ships eslintrc-style presets,
// so they are loaded through FlatCompat. Lint does not gate `next build` (ignoreDuringBuilds).
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FlatCompat } from '@eslint/eslintrc';

const compat = new FlatCompat({ baseDirectory: dirname(fileURLToPath(import.meta.url)) });

const eslintConfig = [
  {
    ignores: [
      '.next/**',
      'node_modules/**',
      'out/**',
      'build/**',
      'dist/**',
      'temp/**',
      'graphify-out/**',
      'next-env.d.ts',
    ],
  },
  ...compat.extends('next/core-web-vitals'),
];

export default eslintConfig;
