/** @type {import('tailwindcss').Config} */
module.exports = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#101827",
        paper: "#f3f5f9",
        accent: "#1c6e8c",
        mint: "#d7f0e4",
        steel: "#2e3a4f"
      }
    }
  },
  plugins: []
};
