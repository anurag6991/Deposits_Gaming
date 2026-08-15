import type { Config } from 'tailwindcss';

export default {
  content: ['./app/**/*.{ts,tsx}', './components/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        // One accent, one danger, one success. The brief asked for restraint:
        // colour here means "this needs attention", not decoration.
        brand: { 50: '#eef4ff', 100: '#d9e5ff', 500: '#3b6fd4', 600: '#2f59ab', 700: '#264a8f' },
      },
    },
  },
  plugins: [],
} satisfies Config;
