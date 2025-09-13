export default {
  test: {
    environment: "node",
    include: ["tests/**/*.{test,spec}.{js,mjs,ts}"],
    exclude: ["node_modules/**", "tests/e2e/**"],
    coverage: {
      reporter: ["text", "lcov"],
      statements: 80,
      branches: 80,
      functions: 80,
      lines: 80
    }
  }
};

