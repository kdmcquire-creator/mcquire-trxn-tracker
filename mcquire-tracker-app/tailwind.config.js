/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      colors: {
        navy: '#1F3864',
        'brand-blue': '#2E75B6',
        'brand-light': '#BDD7EE',
        p10: '#2E75B6',
        llc: '#375623',
        personal: '#595959',
        'ask-kyle': '#ED7D31',
        flagged: '#C00000'
      }
    }
  },
  plugins: []
}
