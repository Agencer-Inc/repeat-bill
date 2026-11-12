import { filesOps } from './files-ops/instances.ts'
import { longJobs } from './long-jobs/instances.ts'
import type { Domain } from './shared.ts'
import { supportOps } from './support-ops/instances.ts'

export const DOMAINS: readonly Domain[] = [supportOps, filesOps, longJobs]

export const domainNamed = (name: string): Domain => {
  const found = DOMAINS.find((d) => d.name === name)
  if (found === undefined) {
    throw new Error(`no domain named ${name}; the domains are ${DOMAINS.map((d) => d.name).join(', ')}`)
  }
  return found
}
