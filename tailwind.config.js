/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      fontFamily: {
        'display': ['Audiowide', 'Chakra Petch', 'sans-serif'],
        'primary': ['Rajdhani', 'Chakra Petch', 'sans-serif'],
        'mono': ['Chakra Petch', 'Orbitron', 'monospace'],
      },
      colors: {
        'sa': {
          'black': 'var(--sa-black)',
          'dark': 'var(--sa-dark-bg)',
          'border': 'var(--sa-border)',
          'border-light': 'var(--sa-border-light)',
          'text': 'var(--sa-text)',
          'text-dim': 'var(--sa-text-dim)',
          'accent': 'var(--sa-accent)',
          'accent-hover': 'var(--sa-accent-hover)',
          'accent-active': 'var(--sa-accent-active)',
        }
      },
      animation: {
        'fade-in-up': 'fadeInUp 0.6s ease forwards',
        'fade-in': 'fadeIn 0.6s ease forwards',
        'slide-in-right': 'slideInRight 0.5s ease forwards',
        'glitch': 'glitch 0.5s ease',
        'ping-slow': 'ping 2s ease-in-out infinite',
        'float': 'float 20s ease-in-out infinite',
      },
      keyframes: {
        fadeInUp: {
          'from': { opacity: '0', transform: 'translateY(10px)' },
          'to': { opacity: '1', transform: 'translateY(0)' },
        },
        fadeIn: {
          'from': { opacity: '0' },
          'to': { opacity: '1' },
        },
        slideInRight: {
          'from': { opacity: '0', transform: 'translateX(20px)' },
          'to': { opacity: '1', transform: 'translateX(0)' },
        },
      },
      boxShadow: {
        'glow': '0 0 20px rgba(var(--sa-accent-rgb), 0.3)',
        'glow-lg': '0 0 40px rgba(var(--sa-accent-rgb), 0.4)',
        'card': '0 20px 40px rgba(var(--sa-accent-rgb), 0.2), 0 0 60px rgba(var(--sa-accent-rgb), 0.1)',
      }
    },
  },
  plugins: [],
}
