// electron/preload/plaid-link-preload.ts
//
// Minimal preload for the Plaid Link child window only.
// Exposes a single bridge object so the HTML page can send results
// back to the main process without nodeIntegration.
//
// IMPORTANT: This file must be compiled alongside the main preload.
// Add it to tsconfig.node.json includes (already covered by "electron/**/*").
// electron-vite will compile it to dist-electron/preload/plaid-link-preload.js
// when you add it to the vite config's preload rollup inputs:
//
//   preload: {
//     plugins: [externalizeDepsPlugin()],
//     build: {
//       rollupOptions: {
//         input: {
//           index: resolve('src/preload/index.ts'),
//           'plaid-link-preload': resolve('electron/preload/plaid-link-preload.ts'), // ← ADD THIS
//         }
//       }
//     }
//   }

import { contextBridge, ipcRenderer } from 'electron'

contextBridge.exposeInMainWorld('plaidBridge', {
  // Called by the HTML page on Plaid onSuccess
  sendSuccess: (result: {
    public_token: string
    institution_id: string
    institution_name: string
    accounts: Array<{ id: string; name: string; mask: string; type: string; subtype: string }>
  }) => {
    ipcRenderer.send('plaid-link:success', result)
  },

  // Called on onExit (user closed Plaid, or cancelled)
  sendExit: () => {
    ipcRenderer.send('plaid-link:exit')
  },

  // Called on JS errors in the page
  sendError: (message: string) => {
    ipcRenderer.send('plaid-link:error', message)
  },
})
