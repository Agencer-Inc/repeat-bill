// Test only: serves the bench's fake model (each job's reference solution) and, with `door`, its fake playbook door,
// printing their base URLs, until killed.
import { domainNamed } from '../tasks/domains.ts'
import { startDoor } from '../test/fake-playbook-door.ts'
import { startFake } from '../test/fake-model.ts'
const domain = domainNamed(process.argv[2] ?? 'support-ops')
if (process.argv[3] === 'door') {
  const door = await startDoor({ domain, seed: 8, days: 2 })
  console.log(door.model.url)
  console.log(door.url)
} else {
  console.log((await startFake({ domain, seed: 8, days: 2 })).url)
}
await new Promise(() => {})
