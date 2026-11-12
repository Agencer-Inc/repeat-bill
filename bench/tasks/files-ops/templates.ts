import type { Args, Call, Template } from '../shared.ts'
import { allOf, amountsIn, cents, countsIn, firstIs, need, onlyEffects, same, says, usd, verdict } from '../shared.ts'
import type { FilesDraw } from './instances.ts'
import type { FilesWorld, Share } from './tools.ts'
import { baseOf, fileById, join, parentOf } from './tools.ts'

type FilesTemplate = Template<FilesWorld, FilesDraw>

const call = (tool: string, args: Args): Call => ({ tool, args })

const isAt = (state: FilesWorld, id: string, want: string): string | null => {
  const got = fileById(state, id).path
  return got === want ? null : `the file meant for ${want} is at ${got}`
}

/** The file's tags are exactly the ones it started with, plus `tag`. */
const tagged = (start: FilesWorld, state: FilesWorld, id: string, tag: string): string | null => {
  const f = fileById(state, id)
  const want = [...fileById(start, id).tags, tag]
  const ok = f.tags.length === want.length && want.every((w) => f.tags.some((t) => same(t, w)))
  return ok ? null : `${f.path} is tagged ${f.tags.join(', ') || 'nothing'}, not ${want.join(', ')}`
}

/** The file's fields are exactly the ones it started with, with `set` written over them. */
const fieldsAre = (start: FilesWorld, state: FilesWorld, id: string, set: Record<string, string>): string | null => {
  const f = fileById(state, id)
  const want = Object.entries({ ...fileById(start, id).fields, ...set })
  const ok = Object.keys(f.fields).length === want.length && want.every(([k, v]) => same(f.fields[k] ?? '', v))
  const listed = (pairs: [string, string][]): string => pairs.map(([k, v]) => `${k} ${v}`).join(', ') || 'no fields'
  return ok ? null : `${f.path} has ${listed(Object.entries(f.fields))}, not ${listed(want)}`
}

const sharedExactly = (state: FilesWorld, id: string, want: readonly Share[]): string | null => {
  const f = fileById(state, id)
  const ok =
    f.shared.length === want.length &&
    want.every((w) => f.shared.some((s) => s.email === w.email.toLowerCase() && s.role === w.role))
  return ok ? null : `${f.path} is shared with ${f.shared.map((s) => `${s.email} as ${s.role}`).join(', ') || 'nobody'}`
}

const folderExists = (state: FilesWorld, folder: string): string | null =>
  state.folders.includes(folder) ? null : `there is no folder ${folder}`

const answers = (ok: boolean, what: string): string | null => (ok ? null : `the reply does not give ${what}`)

/** The kinds of value a question asks for, as they appear in a reply. */
const FILE_PATH = /\/[\w./-]*\.txt\b/g
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g

const moveOne: FilesTemplate = {
  id: 'move-one',
  goal: 'Move a named file into a named folder.',
  forms: [
    'Move {file} into {folder}.',
    'Please put {file} in the folder {folder}.',
    '{file} belongs in {folder}; move it there.',
    'Relocate {file} to {folder}.',
    'Can you move the file {file} over to {folder}?',
  ],
  make: (d) => {
    const desk = d.desk()
    const target = desk.add(`${desk.one}/drafts`)
    const lookalike = desk.add(`${desk.two}/drafts`, undefined, d.nameLike(baseOf(target.path)))
    const folder = `${desk.one}/final`
    return {
      world: desk.world,
      slots: { file: target.path, folder },
      solve: () => ({ calls: [call('move_file', { path: target.path, folder })], reply: `Moved it to ${folder}.` }),
      check: ({ state, effects }) =>
        verdict(
          onlyEffects(effects, [['move_file', target.id]]),
          isAt(state, target.id, join(folder, baseOf(target.path))),
        ),
      decoy: () => call('move_file', { path: lookalike.path, folder }),
    }
  },
}

const renameOne: FilesTemplate = {
  id: 'rename-one',
  goal: 'Rename a named file.',
  forms: [
    'Rename {file} to {name}.',
    'Change the name of {file} to {name}.',
    '{file} should be called {name}. Rename it.',
    'Please give {file} the new name {name}.',
    'Rename the file at {file}; the new name is {name}.',
  ],
  make: (d) => {
    const desk = d.desk()
    const target = desk.add(`${desk.one}/drafts`)
    const lookalike = desk.add(`${desk.one}/drafts`, undefined, d.nameLike(baseOf(target.path)))
    const name = d.name()
    const decoyName = d.name()
    return {
      world: desk.world,
      slots: { file: target.path, name },
      solve: () => ({ calls: [call('rename_file', { path: target.path, name })], reply: `Renamed it to ${name}.` }),
      check: ({ state, effects }) =>
        verdict(
          onlyEffects(effects, [['rename_file', target.id]]),
          isAt(state, target.id, join(parentOf(target.path), name)),
        ),
      decoy: () => call('rename_file', { path: lookalike.path, name: decoyName }),
    }
  },
}

const tagOne: FilesTemplate = {
  id: 'tag-one',
  goal: 'Tag a named file.',
  forms: [
    'Tag {file} as {tag}.',
    'Add the tag {tag} to {file}.',
    'Please put a {tag} tag on {file}.',
    'Mark {file} with the tag {tag}.',
    '{file} needs the {tag} tag.',
  ],
  make: (d) => {
    const desk = d.desk()
    const target = desk.add(`${desk.two}/drafts`)
    const lookalike = desk.add(`${desk.one}/final`, undefined, d.nameLike(baseOf(target.path)))
    const tag = d.word()
    return {
      world: desk.world,
      slots: { file: target.path, tag },
      solve: () => ({ calls: [call('tag_file', { path: target.path, tag })], reply: `Tagged it ${tag}.` }),
      check: ({ start, state, effects }) =>
        verdict(onlyEffects(effects, [['tag_file', target.id]]), tagged(start, state, target.id, tag)),
      decoy: () => call('tag_file', { path: lookalike.path, tag }),
    }
  },
}

const findAndTag: FilesTemplate = {
  id: 'find-and-tag',
  goal: 'Find the file that mentions a phrase and tag it.',
  forms: [
    'Find the file that mentions "{phrase}" and tag it {tag}.',
    'Somewhere there is a file about "{phrase}". Tag it as {tag}.',
    'Tag the file containing "{phrase}" with {tag}.',
    'Search for "{phrase}" and add the tag {tag} to the file you find.',
    'Whichever file talks about "{phrase}" should get the {tag} tag.',
  ],
  make: (d) => {
    const desk = d.desk()
    const [phrase, like] = d.phrases()
    const target = desk.add(`${desk.two}/drafts`, `Notes on the ${phrase}. ${d.filler()}`)
    const lookalike = desk.add(`${desk.one}/drafts`, `Notes on the ${like}. ${d.filler()}`)
    const tag = d.word()
    return {
      world: desk.world,
      slots: { phrase, tag },
      solve: () => ({
        calls: [call('search_files', { text: phrase }), call('tag_file', { path: target.path, tag })],
        reply: `Tagged ${target.path} as ${tag}.`,
      }),
      check: ({ start, state, effects }) =>
        verdict(onlyEffects(effects, [['tag_file', target.id]]), tagged(start, state, target.id, tag)),
      decoy: () => call('tag_file', { path: lookalike.path, tag }),
    }
  },
}

const findAndMove: FilesTemplate = {
  id: 'find-and-move',
  goal: 'Find the file that mentions a phrase and move it into a named folder.',
  forms: [
    'The file about "{phrase}" is in the wrong place. Move it to {folder}.',
    'Find the file that mentions "{phrase}" and move it into {folder}.',
    'Move whichever file covers "{phrase}" to {folder}.',
    'Search for "{phrase}" and put that file in {folder}.',
    'Please file the "{phrase}" document under {folder}.',
  ],
  make: (d) => {
    const desk = d.desk()
    const [phrase, like] = d.phrases()
    const target = desk.add(`${desk.one}/drafts`, `This is the ${phrase}. ${d.filler()}`)
    const lookalike = desk.add(`${desk.one}/final`, `This is the ${like}. ${d.filler()}`)
    const folder = `${desk.two}/drafts`
    return {
      world: desk.world,
      slots: { phrase, folder },
      solve: () => ({
        calls: [call('search_files', { text: phrase }), call('move_file', { path: target.path, folder })],
        reply: `Moved ${baseOf(target.path)} to ${folder}.`,
      }),
      check: ({ state, effects }) =>
        verdict(
          onlyEffects(effects, [['move_file', target.id]]),
          isAt(state, target.id, join(folder, baseOf(target.path))),
        ),
      decoy: () => call('move_file', { path: lookalike.path, folder }),
    }
  },
}

const newFolderMove: FilesTemplate = {
  id: 'new-folder-move',
  goal: 'Make a new folder and move a named file into it.',
  forms: [
    'Make a folder {folder} and move {file} into it.',
    'Create {folder}, then put {file} inside it.',
    'Please set up a new folder at {folder} and move {file} there.',
    '{file} needs to live in a new folder, {folder}. Create it and move the file.',
    'Add the folder {folder} and move {file} into it.',
  ],
  make: (d) => {
    const desk = d.desk()
    const target = desk.add(`${desk.two}/drafts`)
    const lookalike = desk.add(`${desk.two}/drafts`, undefined, d.nameLike(baseOf(target.path)))
    const folder = join(desk.one, d.word())
    return {
      world: desk.world,
      slots: { folder, file: target.path },
      solve: () => ({
        calls: [call('create_folder', { path: folder }), call('move_file', { path: target.path, folder })],
        reply: `Made ${folder} and moved the file in.`,
      }),
      check: ({ state, effects }) =>
        verdict(
          onlyEffects(effects, [
            ['create_folder', folder],
            ['move_file', target.id],
          ]),
          folderExists(state, folder),
          isAt(state, target.id, join(folder, baseOf(target.path))),
        ),
      decoy: () => call('move_file', { path: lookalike.path, folder }),
    }
  },
}

const shareViewer: FilesTemplate = {
  id: 'share-viewer',
  goal: 'Share a named file read-only with an email address.',
  forms: [
    'Share {file} with {email} so they can read it.',
    'Give {email} view access to {file}.',
    'Let {email} see {file}, read-only.',
    'Please share {file} with {email} as a viewer.',
    '{email} should be able to view {file}. Share it with them.',
  ],
  make: (d) => {
    const desk = d.desk()
    const target = desk.add(`${desk.one}/final`)
    const lookalike = desk.add(`${desk.one}/drafts`, undefined, d.nameLike(baseOf(target.path)))
    const { email } = d.person()
    return {
      world: desk.world,
      slots: { file: target.path, email },
      solve: () => ({
        calls: [call('share_file', { path: target.path, email, role: 'viewer' })],
        reply: `Shared with ${email} as a viewer.`,
      }),
      check: ({ state, effects }) =>
        verdict(
          onlyEffects(effects, [['share_file', target.id]]),
          sharedExactly(state, target.id, [{ email, role: 'viewer' }]),
        ),
      decoy: () => call('share_file', { path: lookalike.path, email, role: 'viewer' }),
    }
  },
}

const shareEditorByName: FilesTemplate = {
  id: 'share-editor-by-name',
  goal: 'Share a named file for editing with a person whose email is in the team contacts file.',
  forms: [
    'Give {person} edit rights on {file}. Their email is in /team/contacts.txt.',
    'Share {file} with {person} as an editor. You can find their email in the team contacts file.',
    '{person} needs to edit {file}. Share it with them; contacts are in /team/contacts.txt.',
    'Please let {person} edit {file}. Look their address up in /team/contacts.txt.',
    'Add {person} as an editor on {file}. The team contacts file has their email.',
  ],
  make: (d) => {
    const desk = d.desk()
    const [who, namesake] = desk.people
    const target = desk.add(`${desk.two}/drafts`)
    return {
      world: desk.world,
      slots: { person: who.name, file: target.path },
      solve: () => ({
        calls: [
          call('read_file', { path: '/team/contacts.txt' }),
          call('share_file', { path: target.path, email: who.email, role: 'editor' }),
        ],
        reply: `Shared with ${who.email} as an editor.`,
      }),
      check: ({ state, effects }) =>
        verdict(
          onlyEffects(effects, [['share_file', target.id]]),
          sharedExactly(state, target.id, [{ email: who.email, role: 'editor' }]),
        ),
      decoy: () => call('share_file', { path: target.path, email: namesake.email, role: 'editor' }),
    }
  },
}

const ownerFromText: FilesTemplate = {
  id: 'owner-from-text',
  goal: "Set a file's owner field to the owner the file names.",
  forms: [
    'Read {file} and set its owner field to the person it names as owner.',
    'Set the owner field on {file} from the owner written in the file.',
    '{file} says who owns it. Put that name in its owner field.',
    'Fill in the owner field of {file} using what the file itself says.',
    'Please copy the owner named inside {file} into its owner field.',
  ],
  make: (d) => {
    const desk = d.desk()
    const owner = d.person()
    const reviewer = d.person()
    const target = desk.add(`${desk.one}/drafts`, `Owner: ${owner.name}\nReviewer: ${reviewer.name}\n${d.filler()}`)
    return {
      world: desk.world,
      slots: { file: target.path },
      solve: () => ({
        calls: [
          call('read_file', { path: target.path }),
          call('set_field', { path: target.path, field: 'owner', value: owner.name }),
        ],
        reply: `Set the owner to ${owner.name}.`,
      }),
      check: ({ start, state, effects }) =>
        verdict(
          onlyEffects(effects, [['set_field', target.id]]),
          fieldsAre(start, state, target.id, { owner: owner.name }),
        ),
      decoy: () => call('set_field', { path: target.path, field: 'owner', value: reviewer.name }),
    }
  },
}

const clientFromText: FilesTemplate = {
  id: 'client-from-text',
  goal: "Set a file's client field to the client the file was prepared for.",
  forms: [
    'Set the client field on {file} to the client the document was prepared for.',
    'Read {file} and fill its client field with the client it was prepared for.',
    'Who was {file} prepared for? Put that client in its client field.',
    'Please set the client field of {file} to the client it was written for.',
    'Update {file}: the client field should hold the client it was prepared for.',
  ],
  make: (d) => {
    const desk = d.desk()
    const client = d.client()
    const copy = d.client()
    const target = desk.add(`${desk.two}/drafts`, `Prepared for ${client}\nA copy goes to ${copy}\n${d.filler()}`)
    return {
      world: desk.world,
      slots: { file: target.path },
      solve: () => ({
        calls: [
          call('read_file', { path: target.path }),
          call('set_field', { path: target.path, field: 'client', value: client }),
        ],
        reply: `Set the client to ${client}.`,
      }),
      check: ({ start, state, effects }) =>
        verdict(onlyEffects(effects, [['set_field', target.id]]), fieldsAre(start, state, target.id, { client })),
      decoy: () => call('set_field', { path: target.path, field: 'client', value: copy }),
    }
  },
}

const talkBudget: FilesTemplate = {
  id: 'talk-budget',
  goal: 'Say the budget a file states.',
  forms: [
    'What is the budget in {file}?',
    'How much budget does {file} give?',
    'Tell me the budget figure written in {file}.',
    'Read {file} and tell me its budget.',
    'What budget does the document {file} state?',
  ],
  make: (d) => {
    const desk = d.desk()
    const budget = d.money()
    const target = desk.add(`${desk.one}/final`, `Budget: ${usd(budget)}. Last year: ${usd(d.money())}. ${d.filler()}`)
    return {
      world: desk.world,
      slots: { file: target.path },
      solve: () => ({ calls: [call('read_file', { path: target.path })], reply: `The budget is ${usd(budget)}.` }),
      check: ({ effects, reply }) =>
        verdict(
          onlyEffects(effects, []),
          answers(
            firstIs(amountsIn(reply), (n) => cents(n) === cents(budget)),
            `the budget ${usd(budget)} first`,
          ),
        ),
      decoy: () => call('set_field', { path: target.path, field: 'budget', value: usd(budget) }),
    }
  },
}

const talkCount: FilesTemplate = {
  id: 'talk-count',
  goal: 'Say how many files a folder holds.',
  forms: [
    'How many files are in {folder}?',
    'Count the files in {folder} for me.',
    'Tell me how many files {folder} holds.',
    'What is the number of files in the folder {folder}?',
    'How many documents sit in {folder}?',
  ],
  make: (d) => {
    const desk = d.desk()
    const folder = `${desk.two}/drafts`
    for (let i = d.rng.int(0, 4); i > 0; i--) {
      desk.add(folder)
    }
    const inside = desk.world.files.filter((f) => parentOf(f.path) === folder)
    const first = need(inside[0], 'a file in the folder')
    return {
      world: desk.world,
      slots: { folder },
      solve: () => ({
        calls: [call('list_folder', { path: folder })],
        reply: `${folder} holds ${inside.length} files.`,
      }),
      check: ({ effects, reply }) =>
        verdict(
          onlyEffects(effects, []),
          answers(
            firstIs(countsIn(reply), (n) => n === inside.length),
            `the count ${inside.length} first`,
          ),
        ),
      decoy: () => call('set_field', { path: first.path, field: 'counted', value: 'yes' }),
    }
  },
}

const talkSearch: FilesTemplate = {
  id: 'talk-search',
  goal: 'Give the path of the file that mentions a phrase.',
  forms: [
    'Which file mentions "{phrase}"? Give me its path.',
    'Find the file that talks about "{phrase}" and tell me where it is.',
    'Where is the document about "{phrase}"? I need the full path.',
    'Tell me the path of the file containing "{phrase}".',
    'Search for "{phrase}" and give me the path of the file.',
  ],
  make: (d) => {
    const desk = d.desk()
    const [phrase, like] = d.phrases()
    const target = desk.add(`${desk.one}/final`, `Summary of the ${phrase}. ${d.filler()}`)
    desk.add(`${desk.two}/drafts`, `Summary of the ${like}. ${d.filler()}`)
    return {
      world: desk.world,
      slots: { phrase },
      solve: () => ({ calls: [call('search_files', { text: phrase })], reply: `It is ${target.path}.` }),
      check: ({ effects, reply }) =>
        verdict(
          onlyEffects(effects, []),
          answers(
            firstIs(allOf(reply, FILE_PATH), (p) => p === target.path),
            `the path ${target.path} first`,
          ),
        ),
      decoy: () => call('set_field', { path: target.path, field: 'found', value: 'yes' }),
    }
  },
}

const tagFolder: FilesTemplate = {
  id: 'tag-folder',
  goal: 'Tag every file directly in a named folder.',
  forms: [
    'Tag every file in {folder} as {tag}.',
    'Add the tag {tag} to all the files in {folder}.',
    'Everything in {folder} needs the {tag} tag.',
    'Please put a {tag} tag on each file in {folder}.',
    'Go through {folder} and tag each file {tag}.',
  ],
  make: (d) => {
    const desk = d.desk()
    const folder = `${desk.one}/final`
    for (let i = d.rng.int(1, 2); i > 0; i--) {
      desk.add(folder)
    }
    const inside = desk.world.files.filter((f) => parentOf(f.path) === folder)
    const outside = need(
      desk.world.files.find((f) => parentOf(f.path) === `${desk.one}/drafts`),
      'a file next door',
    )
    const tag = d.word()
    return {
      world: desk.world,
      slots: { folder, tag },
      solve: () => ({
        calls: [call('list_folder', { path: folder }), ...inside.map((f) => call('tag_file', { path: f.path, tag }))],
        reply: `Tagged ${inside.length} files ${tag}.`,
      }),
      check: ({ start, state, effects }) =>
        verdict(
          onlyEffects(
            effects,
            inside.map((f) => ['tag_file', f.id] as const),
          ),
          ...inside.map((f) => tagged(start, state, f.id, tag)),
        ),
      decoy: () => call('tag_file', { path: outside.path, tag }),
    }
  },
}

const renameAndTag: FilesTemplate = {
  id: 'rename-and-tag',
  goal: 'Rename a named file and tag it.',
  forms: [
    'Rename {file} to {name} and tag it {tag}.',
    'Give {file} the name {name}, then add the tag {tag}.',
    'Tag {file} as {tag} and rename it to {name}.',
    '{file} becomes {name}, with the tag {tag}.',
    'Please rename {file} to {name}; it also needs the {tag} tag.',
  ],
  make: (d) => {
    const desk = d.desk()
    const target = desk.add(`${desk.one}/drafts`)
    const lookalike = desk.add(`${desk.one}/drafts`, undefined, d.nameLike(baseOf(target.path)))
    const name = d.name()
    const tag = d.word()
    const renamed = join(parentOf(target.path), name)
    return {
      world: desk.world,
      slots: { file: target.path, name, tag },
      solve: () => ({
        calls: [call('rename_file', { path: target.path, name }), call('tag_file', { path: renamed, tag })],
        reply: `Renamed to ${name} and tagged ${tag}.`,
      }),
      check: ({ start, state, effects }) =>
        verdict(
          onlyEffects(effects, [
            ['rename_file', target.id],
            ['tag_file', target.id],
          ]),
          isAt(state, target.id, renamed),
          tagged(start, state, target.id, tag),
        ),
      decoy: () => call('tag_file', { path: lookalike.path, tag }),
    }
  },
}

const moveAndShare: FilesTemplate = {
  id: 'move-and-share',
  goal: 'Move a named file into a named folder and share it for editing.',
  forms: [
    'Move {file} to {folder} and share it with {email} as an editor.',
    'Put {file} in {folder}, then give {email} edit access.',
    'Share {file} with {email} as an editor and move it into {folder}.',
    '{file} goes to {folder}, and {email} should be able to edit it.',
    'Please move {file} over to {folder} and let {email} edit it.',
  ],
  make: (d) => {
    const desk = d.desk()
    const target = desk.add(`${desk.one}/drafts`)
    const lookalike = desk.add(`${desk.one}/final`, undefined, d.nameLike(baseOf(target.path)))
    const folder = `${desk.two}/drafts`
    const { email } = d.person()
    const moved = join(folder, baseOf(target.path))
    return {
      world: desk.world,
      slots: { file: target.path, folder, email },
      solve: () => ({
        calls: [
          call('move_file', { path: target.path, folder }),
          call('share_file', { path: moved, email, role: 'editor' }),
        ],
        reply: `Moved and shared with ${email}.`,
      }),
      check: ({ state, effects }) =>
        verdict(
          onlyEffects(effects, [
            ['move_file', target.id],
            ['share_file', target.id],
          ]),
          isAt(state, target.id, moved),
          sharedExactly(state, target.id, [{ email, role: 'editor' }]),
        ),
      decoy: () => call('share_file', { path: lookalike.path, email, role: 'editor' }),
    }
  },
}

const STATUSES = ['done', 'open', 'draft', 'in review'] as const

export const REVIEW_STATES = ['approved', 'on hold', 'in review'] as const

const archiveDone: FilesTemplate = {
  id: 'archive-done',
  goal: 'Move every file in a named folder whose status field is done into /archive.',
  forms: [
    'Move every file in {folder} whose status field is done into /archive.',
    'Archive the files in {folder} marked done: move them to /archive.',
    'In {folder}, anything with status done goes to /archive. Please move them.',
    'Clear the finished files out of {folder} into /archive; finished means the status field is done.',
    'Look through {folder} and move each file with status done to /archive.',
  ],
  make: (d) => {
    const desk = d.desk()
    const folder = `${desk.two}/drafts`
    for (let i = d.rng.int(1, 2); i > 0; i--) {
      desk.add(folder)
    }
    const inside = desk.world.files.filter((f) => parentOf(f.path) === folder)
    const statuses = d.rng.shuffle(inside.map((_, i) => (i === 0 ? 'done' : i === 1 ? 'open' : d.rng.pick(STATUSES))))
    inside.forEach((f, i) => {
      f.fields.status = need(statuses[i], 'a status')
    })
    const done = inside.filter((f) => f.fields.status === 'done')
    const kept = need(
      inside.find((f) => f.fields.status !== 'done'),
      'a file not done',
    )
    return {
      world: desk.world,
      slots: { folder },
      solve: () => ({
        calls: [
          call('list_folder', { path: folder }),
          ...inside.map((f) => call('read_file', { path: f.path })),
          ...done.map((f) => call('move_file', { path: f.path, folder: '/archive' })),
        ],
        reply: `Moved ${done.length} done files to /archive.`,
      }),
      check: ({ state, effects }) =>
        verdict(
          onlyEffects(
            effects,
            done.map((f) => ['move_file', f.id] as const),
          ),
          ...done.map((f) => isAt(state, f.id, join('/archive', baseOf(f.path)))),
        ),
      decoy: () => call('move_file', { path: kept.path, folder: '/archive' }),
    }
  },
}

const setTwoFields: FilesTemplate = {
  id: 'set-two-fields',
  goal: 'Set two named fields on a named file.',
  forms: [
    'On {file}, set status to {status} and reviewer to {reviewer}.',
    'Set the status field of {file} to {status} and its reviewer field to {reviewer}.',
    'Please update {file}: status {status}, reviewer {reviewer}.',
    '{file} needs status {status} and reviewer {reviewer}.',
    "Fill in {file}'s fields: the reviewer is {reviewer} and the status is {status}.",
  ],
  make: (d) => {
    const desk = d.desk()
    const target = desk.add(`${desk.two}/drafts`)
    const lookalike = desk.add(`${desk.one}/drafts`, undefined, d.nameLike(baseOf(target.path)))
    const status = d.rng.pick(REVIEW_STATES)
    const reviewer = d.person().name
    return {
      world: desk.world,
      slots: { file: target.path, status, reviewer },
      solve: () => ({
        calls: [
          call('set_field', { path: target.path, field: 'status', value: status }),
          call('set_field', { path: target.path, field: 'reviewer', value: reviewer }),
        ],
        reply: 'Both fields are set.',
      }),
      check: ({ start, state, effects }) =>
        verdict(
          onlyEffects(effects, [['set_field', target.id]]),
          fieldsAre(start, state, target.id, { status, reviewer }),
        ),
      decoy: () => call('set_field', { path: lookalike.path, field: 'reviewer', value: reviewer }),
    }
  },
}

const shareTwo: FilesTemplate = {
  id: 'share-two',
  goal: 'Share a named file read-only with two email addresses.',
  forms: [
    'Share {file} with {one} and {two}, both read-only.',
    'Give {one} and {two} view access to {file}.',
    'Let {one} and {two} read {file}, without edit rights.',
    'Please share {file} as a viewer with {two} and with {one}.',
    '{file} should be viewable by {one} and {two}.',
  ],
  make: (d) => {
    const desk = d.desk()
    const target = desk.add(`${desk.one}/final`)
    const lookalike = desk.add(`${desk.two}/drafts`, undefined, d.nameLike(baseOf(target.path)))
    const one = d.person().email
    const two = d.person().email
    return {
      world: desk.world,
      slots: { file: target.path, one, two },
      solve: () => ({
        calls: [
          call('share_file', { path: target.path, email: one, role: 'viewer' }),
          call('share_file', { path: target.path, email: two, role: 'viewer' }),
        ],
        reply: 'Shared with both, read-only.',
      }),
      check: ({ state, effects }) =>
        verdict(
          onlyEffects(effects, [['share_file', target.id]]),
          sharedExactly(state, target.id, [
            { email: one, role: 'viewer' },
            { email: two, role: 'viewer' },
          ]),
        ),
      decoy: () => call('share_file', { path: lookalike.path, email: one, role: 'viewer' }),
    }
  },
}

const talkSharedWith: FilesTemplate = {
  id: 'talk-shared-with',
  goal: 'Say every email address a named file is shared with.',
  forms: [
    'Who is {file} shared with?',
    'List the people who have access to {file}.',
    'Tell me who {file} is shared with.',
    'Which email addresses can see {file}?',
    "Read {file}'s sharing and tell me who has access.",
  ],
  make: (d) => {
    const desk = d.desk()
    const target = desk.add(`${desk.two}/drafts`)
    const lookalike = desk.add(`${desk.one}/drafts`, undefined, d.nameLike(baseOf(target.path)))
    for (let i = d.rng.int(2, 3); i > 0; i--) {
      target.shared.push({ email: d.person().email, role: d.rng.pick(['viewer', 'editor'] as const) })
    }
    lookalike.shared.push({ email: d.person().email, role: 'viewer' })
    const emails = target.shared.map((s) => s.email)
    return {
      world: desk.world,
      slots: { file: target.path },
      solve: () => ({
        calls: [call('read_file', { path: target.path })],
        reply: `It is shared with ${emails.join(', ')}.`,
      }),
      check: ({ effects, reply }) =>
        verdict(
          onlyEffects(effects, []),
          answers(
            allOf(reply.toLowerCase(), EMAIL).every((e) => emails.includes(e)),
            'only addresses the file is shared with',
          ),
          ...emails.map((e) => answers(says(reply, e), `the address ${e}`)),
        ),
      decoy: () => call('share_file', { path: target.path, email: need(emails[0], 'an email'), role: 'editor' }),
    }
  },
}

export const TEMPLATES: readonly FilesTemplate[] = [
  moveOne,
  renameOne,
  tagOne,
  findAndTag,
  findAndMove,
  newFolderMove,
  shareViewer,
  shareEditorByName,
  ownerFromText,
  clientFromText,
  talkBudget,
  talkCount,
  talkSearch,
  tagFolder,
  renameAndTag,
  moveAndShare,
  archiveDone,
  setTwoFields,
  shareTwo,
  talkSharedWith,
]
