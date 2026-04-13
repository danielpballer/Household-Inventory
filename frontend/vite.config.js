import { defineConfig } from 'vite';
import preact from '@preact/preset-vite';

export default defineConfig({
  plugins: [preact()],
  // base is '/' for local dev and GitHub Pages with a custom domain.
  // If deploying to github.io/<repo-name>/ (no custom domain), set this to
  // '/<repo-name>/' or pass --base=/<repo-name>/ in the build command.
  // We'll handle this in the GitHub Actions workflow (Step 16).
  base: '/',
});
