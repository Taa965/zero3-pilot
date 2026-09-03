import { readFile, realpath, stat } from 'node:fs/promises'
import path from 'node:path'

import type { AcpAdapterSpec, ResolvedAcpAdapter } from './acp-types.ts'

type PackageManifest = {
  name?: unknown
  version?: unknown
  bin?: unknown
}

function safeRelativeBin(bin: unknown, binName: string): string {
  if (typeof bin === 'string') return bin
  if (!bin || typeof bin !== 'object' || Array.isArray(bin)) throw new Error('ACP adapter package has no executable bin mapping')
  const target = (bin as Record<string, unknown>)[binName]
  if (typeof target !== 'string' || !target.trim()) throw new Error(`ACP adapter package has no bin named ${binName}`)
  return target
}

export async function resolveExactLocalAcpAdapter(spec: AcpAdapterSpec): Promise<ResolvedAcpAdapter> {
  if (!path.isAbsolute(spec.packageRoot)) throw new Error('ACP packageRoot must be absolute')
  const packageRoot = await realpath(spec.packageRoot)
  const packageJson = path.join(packageRoot, 'package.json')
  const manifest = JSON.parse(await readFile(packageJson, 'utf8')) as PackageManifest
  if (manifest.name !== spec.packageName) throw new Error('ACP adapter package name does not match frozen configuration')
  if (manifest.version !== spec.packageVersion) throw new Error('ACP adapter package version does not match frozen exact pin')
  const relativeBin = safeRelativeBin(manifest.bin, spec.binName)
  if (path.isAbsolute(relativeBin)) throw new Error('ACP adapter bin path must be package-relative')
  const binPath = await realpath(path.resolve(packageRoot, relativeBin))
  const rootPrefix = packageRoot.endsWith(path.sep) ? packageRoot : `${packageRoot}${path.sep}`
  if (!binPath.startsWith(rootPrefix)) throw new Error('ACP adapter bin escapes its installed package root')
  const metadata = await stat(binPath)
  if (!metadata.isFile()) throw new Error('ACP adapter bin is not a regular file')

  const extension = path.extname(binPath).toLowerCase()
  const directExecutable = process.platform === 'win32' && extension === '.exe'
  return {
    command: directExecutable ? binPath : process.execPath,
    args: directExecutable ? [...(spec.extraArgs ?? [])] : [binPath, ...(spec.extraArgs ?? [])],
    cwd: packageRoot,
    env: { ...process.env, ...(spec.env ?? {}) },
    packageName: spec.packageName,
    packageVersion: spec.packageVersion
  }
}
