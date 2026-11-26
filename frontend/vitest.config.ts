import { mergeConfig } from 'vitest/config'
import viteConfig from './vite.config'

// Tests must not read deployment environment files.
export default mergeConfig(viteConfig, { envDir: false })