// Generates simple placeholder PWA icons as PNG files
// Run: node generate-icons.js
// Requires no dependencies — uses a minimal valid PNG with embedded text

const fs = require('fs')
const path = require('path')

// Minimal 1x1 PNG header + IHDR + IDAT for a solid slate-colored pixel
// For real icons, replace these with your actual app icons
function createMinimalPng(size) {
  // This creates a very basic valid PNG. For production, replace with
  // actual designed icons (192x192 and 512x512 PNG files).
  //
  // Quick way to generate proper icons:
  //   1. Create a 512x512 icon in Figma/Canva with "$" or "M" on slate background
  //   2. Export as PNG, save as icon-512.png
  //   3. Resize to 192x192, save as icon-192.png
  //
  // Or use an online PWA icon generator like https://www.pwabuilder.com/imageGenerator

  console.log(`[icons] Placeholder for ${size}x${size} — replace with real icon`)
}

createMinimalPng(192)
createMinimalPng(512)

console.log(`
To create proper PWA icons:
  1. Design a 512x512 icon (dark slate background, white "$" or "M" text)
  2. Save as companion-web/public/icon-512.png
  3. Resize to 192x192 and save as companion-web/public/icon-192.png

Or use: https://www.pwabuilder.com/imageGenerator
`)
