import type { Picker, Rng } from '../shared.ts'
import { WORDS, defineDomain, dollars, listOf, need, person, surnameOf } from '../shared.ts'
import { REVIEW_STATES, TEMPLATES } from './templates.ts'
import type { FileEntry, FilesWorld } from './tools.ts'
import { ACTING, SYSTEM, TOOLS, filesIdentities, filesTable, join } from './tools.ts'

const FILLER = [
  'Working notes, nothing final yet.',
  'Minutes from the weekly check-in.',
  'A rough list of open questions.',
  'Draft text for the next update.',
  'Notes copied from the whiteboard.',
  'Ideas to raise at the next planning session.',
]

const KINDS = listOf('review proposal audit estimate survey handover')
const SUFFIXES = listOf('Ltd Group Partners Studio Works')

export interface Person {
  name: string
  email: string
}

/** Two project folders with drafts, a team contacts file naming three people, and filler files. */
export interface Desk {
  world: FilesWorld
  one: string
  two: string
  /** In /team/contacts.txt. The second has the first one's surname. */
  people: [Person, Person, Person]
  add: (folder: string, content?: string, name?: string) => FileEntry
}

export interface FilesDraw {
  rng: Rng
  desk: () => Desk
  /** A fresh file name, like amber-ridge.txt. */
  name: () => string
  /** A fresh file name sharing its first word with `name`. */
  nameLike: (name: string) => string
  /** A fresh folder name or tag, like cedar-wharf. */
  word: () => string
  person: (surname?: string) => Person
  /** A fresh phrase, and a fresh look-alike that shares its first word and its kind. */
  phrases: () => [string, string]
  client: () => string
  money: () => number
  filler: () => string
}

const title = (word: string): string => `${word.charAt(0).toUpperCase()}${word.slice(1)}`

const filesDraws = (rng: Rng, pick: Picker): FilesDraw => {
  const two = (): [string, string] => {
    const [a, b] = rng.sample(WORDS, 2)
    return [need(a, 'a word'), need(b, 'a word')]
  }
  const word = (): string => pick.fresh(() => two().join('-'))
  const name = (): string => pick.fresh(() => `${two().join('-')}.txt`)
  const nameLike = (like: string): string => {
    const first = need(like.split('-')[0], 'a first word')
    return pick.fresh(() => `${first}-${rng.pick(WORDS.filter((w) => w !== first))}.txt`)
  }
  const drawPerson = (surname?: string): Person => {
    let drawn = person(rng, surname)
    pick.fresh(() => {
      drawn = person(rng, surname)
      return drawn.name
    })
    return { name: drawn.name, email: pick.fresh(() => drawn.email) }
  }
  const filler = (): string => rng.pick(FILLER)

  const desk = (): Desk => {
    const one = `/${word()}`
    const other = `/${word()}`
    const world: FilesWorld = {
      folders: ['/archive', '/team', one, `${one}/drafts`, `${one}/final`, other, `${other}/drafts`],
      files: [],
    }
    let count = 0
    const add = (folder: string, content?: string, fileName?: string): FileEntry => {
      count += 1
      const entry: FileEntry = {
        id: `file-${count}`,
        path: join(folder, fileName ?? name()),
        content: content ?? filler(),
        tags: [],
        fields: {},
        shared: [],
      }
      world.files.push(entry)
      return entry
    }
    const first = drawPerson()
    const people: [Person, Person, Person] = [first, drawPerson(surnameOf(first.name)), drawPerson()]
    add('/team', rng.shuffle(people.map((p) => `${p.name} <${p.email}>`)).join('\n'), 'contacts.txt')
    add(`${one}/drafts`)
    add(`${one}/drafts`)
    add(`${one}/final`)
    add(`${other}/drafts`)
    add(`${other}/drafts`)
    add(other)
    return { world, one, two: other, people, add }
  }

  return {
    rng,
    desk,
    name,
    nameLike,
    word,
    person: drawPerson,
    phrases: () => {
      const kind = rng.pick(KINDS)
      let lead = ''
      const phrase = pick.fresh(() => {
        const [a, b] = two()
        lead = a
        return `${title(a)} ${title(b)} ${kind}`
      })
      const like = pick.fresh(() => `${title(lead)} ${title(rng.pick(WORDS.filter((w) => w !== lead)))} ${kind}`)
      return [phrase, like]
    },
    client: () => pick.fresh(() => `${two().map(title).join(' ')} ${rng.pick(SUFFIXES)}`),
    money: () => dollars(rng.int(100000, 9999999)),
    filler,
  }
}

export const filesOps = defineDomain({
  name: 'files-ops',
  system: SYSTEM,
  tools: TOOLS,
  acting: ACTING,
  vocabulary: REVIEW_STATES,
  templates: TEMPLATES,
  draws: filesDraws,
  table: filesTable,
  identities: filesIdentities,
})
