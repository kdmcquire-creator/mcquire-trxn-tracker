// tests/claude-classifier.test.ts
// Unit tests for Claude AI classifier service (non-API parts)

import { describe, it, expect, vi } from 'vitest'

// We can't test actual API calls without a key, but we can test the module imports
// and the credential helpers by mocking electron's safeStorage
vi.mock('electron', () => ({
  safeStorage: {
    encryptString: (s: string) => Buffer.from(s),
    decryptString: (b: Buffer) => b.toString(),
  },
  app: {
    getPath: () => '/tmp/test-mcquire',
  },
}))

vi.mock('fs', async () => {
  const store: Record<string, Buffer> = {}
  return {
    existsSync: (p: string) => p in store,
    mkdirSync: () => {},
    writeFileSync: (p: string, data: Buffer) => { store[p] = data },
    readFileSync: (p: string) => store[p],
    unlinkSync: (p: string) => { delete store[p] },
    default: {
      existsSync: (p: string) => p in store,
      mkdirSync: () => {},
      writeFileSync: (p: string, data: Buffer) => { store[p] = data },
      readFileSync: (p: string) => store[p],
      unlinkSync: (p: string) => { delete store[p] },
    },
  }
})

import { saveClaudeApiKey, loadClaudeApiKey, hasClaudeApiKey, deleteClaudeApiKey } from '../electron/services/claude-classifier'

describe('Claude API key management', () => {
  it('initially has no key', () => {
    expect(hasClaudeApiKey()).toBe(false)
  })

  it('saves and loads an API key', () => {
    saveClaudeApiKey('sk-ant-test-key-123')
    expect(hasClaudeApiKey()).toBe(true)
    expect(loadClaudeApiKey()).toBe('sk-ant-test-key-123')
  })

  it('deletes an API key', () => {
    saveClaudeApiKey('sk-ant-test-key-456')
    expect(hasClaudeApiKey()).toBe(true)
    deleteClaudeApiKey()
    expect(hasClaudeApiKey()).toBe(false)
  })
})
