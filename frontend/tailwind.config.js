/** @type {import('tailwindcss').Config} */
export default {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        brand: { 50: '#eff6ff', 600: '#2563eb', 700: '#1d4ed8' },
      },
      fontFamily: {
        sans: ['Manrope', 'sans-serif'],
        mono: ['IBM Plex Mono', 'monospace'],
      },
      boxShadow: {
        soft: '0 14px 35px -20px rgba(15, 23, 42, 0.28)',
      },
    },
  },
  plugins: [],
}

