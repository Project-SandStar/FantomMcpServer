// Script to copy workflow markdown files to build directory
const fs = require('fs-extra');
const path = require('path');

async function copyWorkflows() {
  const srcDir = path.join(__dirname, '..', 'workflows');
  const destDir = path.join(__dirname, '..', 'build', 'workflows');

  try {
    // Ensure destination exists
    await fs.ensureDir(destDir);

    // Copy all markdown files
    await fs.copy(srcDir, destDir, {
      filter: (src) => {
        return src.endsWith('.md') || fs.statSync(src).isDirectory();
      }
    });

    console.log('✓ Workflows copied to build directory');
  } catch (error) {
    console.error('Error copying workflows:', error);
    process.exit(1);
  }
}

copyWorkflows();
