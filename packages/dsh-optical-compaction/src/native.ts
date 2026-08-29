import { createRequire } from 'node:module'
import type { SnapcompactRenderOptions } from '@oh-my-pi/pi-natives'

interface SnapcompactNativeBindings {
  renderSnapcompactPng(text: string, options: SnapcompactRenderOptions): Promise<string>
  snapcompactSupportedChars(font: string, chars: string): string
}

const PLATFORM_PACKAGES: Readonly<Record<string, string>> = {
  'linux-x64': '@oh-my-pi/pi-natives-linux-x64',
  'linux-arm64': '@oh-my-pi/pi-natives-linux-arm64',
  'darwin-x64': '@oh-my-pi/pi-natives-darwin-x64',
  'darwin-arm64': '@oh-my-pi/pi-natives-darwin-arm64',
  'win32-x64': '@oh-my-pi/pi-natives-win32-x64',
}

const platformTag = `${process.platform}-${process.arch}`
const packageName = PLATFORM_PACKAGES[platformTag]
if (packageName === undefined) {
  throw new Error(`dsh-optical-compaction: OMP native renderer does not support ${platformTag}`)
}

// OMP's generated top-level loader currently reads Bun's import.meta.dir.
// DSH runs Node, so load the exact platform N-API package directly; its safe
// baseline entry exports the same renderSnapcompactPng contract.
const require = createRequire(import.meta.url)
const bindings = require(packageName) as SnapcompactNativeBindings

export const renderSnapcompactPng = bindings.renderSnapcompactPng
export const snapcompactSupportedChars = bindings.snapcompactSupportedChars
