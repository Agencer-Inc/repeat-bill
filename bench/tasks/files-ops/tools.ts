import type { Args, Effect, ToolSpec } from '../shared.ts'
import { ToolError, choice, need, text, tool } from '../shared.ts'

export const ROLES = ['viewer', 'editor'] as const
export type Role = (typeof ROLES)[number]

export interface Share {
  email: string
  role: Role
}

export interface FileEntry {
  /** Stable across moves and renames; never shown to the model. */
  id: string
  path: string
  content: string
  tags: string[]
  fields: Record<string, string>
  shared: Share[]
}

export interface FilesWorld {
  folders: string[]
  files: FileEntry[]
}

export const SYSTEM = [
  "You are the assistant on a team's document desk. A member of the team asks you to do a job on the shared files.",
  'Use the tools to look things up and to act; never guess a path or an email address.',
  'Paths start at / and folders are separated by /, for example /harbor-plans/drafts/budget-notes.txt.',
  'When the job is done, or cannot be done, answer in one or two sentences, and include any fact you were asked for.',
].join(' ')

const path = (description: string) => ({ type: 'string' as const, description })

export const TOOLS: readonly ToolSpec[] = [
  tool('list_folder', 'List the folders and files directly inside a folder. Use / for the top.', {
    path: path('Folder path.'),
  }),
  tool('read_file', "Read a file's text, its tags, its fields and who it is shared with.", {
    path: path('File path.'),
  }),
  tool('search_files', 'Find files whose name or text contains a piece of text, ignoring case.', {
    text: path('The text to look for.'),
  }),
  tool('create_folder', 'Make a new folder inside a folder that exists.', { path: path('The new folder path.') }),
  tool('move_file', 'Move a file into another folder, keeping its name.', {
    path: path('File path.'),
    folder: path('The folder to move it into.'),
  }),
  tool('rename_file', 'Give a file a new name in the same folder.', {
    path: path('File path.'),
    name: path('The new file name, with no folder part.'),
  }),
  tool('tag_file', 'Add a tag to a file.', { path: path('File path.'), tag: path('The tag.') }),
  tool('set_field', 'Set a named field on a file, replacing any value it had.', {
    path: path('File path.'),
    field: path('Field name, like owner or status.'),
    value: path('The value.'),
  }),
  tool('share_file', 'Share a file with someone by email, as a viewer or an editor.', {
    path: path('File path.'),
    email: path('Their email address.'),
    role: { type: 'string', description: 'viewer can read; editor can change.', enum: ROLES },
  }),
]

export const ACTING = ['create_folder', 'move_file', 'rename_file', 'tag_file', 'set_field', 'share_file']

export const parentOf = (p: string): string => p.slice(0, p.lastIndexOf('/')) || '/'

export const baseOf = (p: string): string => p.slice(p.lastIndexOf('/') + 1)

export const join = (folder: string, name: string): string => `${folder === '/' ? '' : folder}/${name}`

export const fileById = (world: FilesWorld, id: string): FileEntry =>
  need(
    world.files.find((f) => f.id === id),
    `file ${id}`,
  )

const clean = (raw: string): string => {
  const p = `/${raw.trim().replace(/^\/+/, '').replace(/\/+$/, '')}`
  return p === '/' ? '/' : p.replace(/\/{2,}/g, '/')
}

export const filesTable = (state: FilesWorld, effects: Effect[]): Record<string, (args: Args) => unknown> => {
  const isFolder = (p: string): boolean => p === '/' || state.folders.includes(p)
  const taken = (p: string): boolean => isFolder(p) || state.files.some((f) => f.path === p)
  const folder = (args: Args, key: string): string => {
    const p = clean(text(args, key))
    if (!isFolder(p)) {
      throw new ToolError(`no folder ${p}`)
    }
    return p
  }
  const file = (args: Args): FileEntry => {
    const p = clean(text(args, 'path'))
    const found = state.files.find((f) => f.path === p)
    if (found === undefined) {
      throw new ToolError(`no file ${p}`)
    }
    return found
  }
  const record = (tool: string, args: Args, target: string): void => {
    effects.push({ tool, args: structuredClone(args), target })
  }
  const view = (f: FileEntry) => ({
    path: f.path,
    content: f.content,
    tags: f.tags,
    fields: f.fields,
    shared: f.shared,
  })

  return {
    list_folder: (args) => {
      const p = folder(args, 'path')
      return {
        path: p,
        folders: state.folders.filter((f) => f !== '/' && parentOf(f) === p).sort(),
        files: state.files
          .filter((f) => parentOf(f.path) === p)
          .map((f) => ({ name: baseOf(f.path), path: f.path }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      }
    },
    read_file: (args) => view(file(args)),
    search_files: (args) => {
      const needle = text(args, 'text').toLowerCase()
      return state.files
        .filter((f) => f.content.toLowerCase().includes(needle) || baseOf(f.path).toLowerCase().includes(needle))
        .map((f) => ({ path: f.path }))
        .sort((a, b) => a.path.localeCompare(b.path))
    },
    create_folder: (args) => {
      const p = clean(text(args, 'path'))
      if (!isFolder(parentOf(p))) {
        throw new ToolError(`no folder ${parentOf(p)}`)
      }
      if (taken(p)) {
        throw new ToolError(`${p} already exists`)
      }
      state.folders.push(p)
      record('create_folder', args, p)
      return { created: p }
    },
    move_file: (args) => {
      const f = file(args)
      const to = join(folder(args, 'folder'), baseOf(f.path))
      if (taken(to)) {
        throw new ToolError(`${to} already exists`)
      }
      f.path = to
      record('move_file', args, f.id)
      return { path: f.path }
    },
    rename_file: (args) => {
      const f = file(args)
      const name = text(args, 'name')
      if (name.includes('/')) {
        throw new ToolError('name must not contain /')
      }
      const to = join(parentOf(f.path), name)
      if (taken(to)) {
        throw new ToolError(`${to} already exists`)
      }
      f.path = to
      record('rename_file', args, f.id)
      return { path: f.path }
    },
    tag_file: (args) => {
      const f = file(args)
      const tag = text(args, 'tag')
      if (!f.tags.some((t) => t.toLowerCase() === tag.toLowerCase())) {
        f.tags.push(tag)
      }
      record('tag_file', args, f.id)
      return { path: f.path, tags: f.tags }
    },
    set_field: (args) => {
      const f = file(args)
      const field = text(args, 'field').toLowerCase()
      f.fields[field] = text(args, 'value')
      record('set_field', args, f.id)
      return { path: f.path, fields: f.fields }
    },
    share_file: (args) => {
      const f = file(args)
      const email = text(args, 'email').toLowerCase()
      if (!email.includes('@')) {
        throw new ToolError('email must be an email address')
      }
      const role = choice(args, 'role', ROLES)
      const held = f.shared.find((s) => s.email === email)
      if (held === undefined) {
        f.shared.push({ email, role })
      } else {
        held.role = role
      }
      record('share_file', args, f.id)
      return { path: f.path, shared: f.shared }
    },
  }
}

/** Path parts every desk has; they name places, not data, so they repeat across tasks. */
export const FIXED_PARTS = new Set(['archive', 'team', 'drafts', 'final', 'contacts.txt'])

/** The identifying values in a file tree, read from its records. */
export const filesIdentities = (world: FilesWorld): string[] => {
  const parts = [...world.folders, ...world.files.map((f) => f.path)].flatMap((p) => p.split('/').filter(Boolean))
  return [
    ...new Set([
      ...parts.filter((p) => !FIXED_PARTS.has(p)),
      ...world.files.flatMap((f) => f.tags),
      ...world.files.flatMap((f) =>
        Object.entries(f.fields)
          .filter(([k]) => k !== 'status')
          .map(([, v]) => v),
      ),
      ...world.files.flatMap((f) => f.shared.map((s) => s.email)),
    ]),
  ]
}
