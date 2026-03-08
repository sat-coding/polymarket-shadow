import type { Config } from 'tailwindcss'

const config: Config = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        mono: ['JetBrains Mono', 'Fira Code', 'ui-monospace', 'monospace'],
      },
      colors: {
        surface: '#111118',
        border: '#1e1e2e',
        'border-bright': '#2a2a3e',
      },
      animation: {
        'pulse-border': 'pulse-border 1s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}

export default config
