import type { Runner } from './fly.js'
import { readProjectLink, markSkillsInstalled, ensureGitignore } from './config.js'

// Where `npx skills add` / `firth skills pull` drop skills, per detected agent.
// These are regenerable agent context, not the developer's source — keep them out of git.
const SKILL_DIRS = ['.claude/skills/', '.agents/skills/', '.github/skills/']

type SkillsDeps = { print: (s: string) => void; cwd: string; run?: Runner }

// Agent skills installed once per linked project so the developer's agent has
// Neon / Tigris / Firth context. Run via `npx skills add` (vercel-labs/skills),
// fully non-interactively: pin the agents (Claude Code → `.claude/skills/`, Codex
// → `.agents/skills/`; both already gitignored) so there's no agent prompt and the
// tool doesn't fan out to ~13–72 agent dirs; explicit `-s` skill names (no skill
// prompt); `-y` (no scope/confirm prompt); `--copy` (real files, not symlinks into
// a transient package cache).
const AGENT_FLAGS = ['-a', 'claude-code', '-a', 'codex', '-y', '--copy']
const SKILLS: Array<{ label: string; args: string[] }> = [
  { label: 'neon-postgres', args: ['skills', 'add', 'neondatabase/agent-skills', '-s', 'neon-postgres', ...AGENT_FLAGS] },
  { label: 'tigris', args: ['skills', 'add', 'tigrisdata/skills',
    '-s', 'tigris-object-operations', '-s', 'file-storage', '-s', 'tigris-sdk-guide',
    '-s', 'tigris-security-access-control', '-s', 'tigris-image-optimization',
    '-s', 'tigris-s3-migration', '-s', 'tigris-static-assets', '-s', 'tigris-agent-kit',
    ...AGENT_FLAGS] },
  { label: 'better-auth', args: ['skills', 'add', 'better-auth/skills',
    '-s', 'better-auth-best-practices', '-s', 'email-and-password-best-practices',
    '-s', 'better-auth-security-best-practices', ...AGENT_FLAGS] },
  { label: 'firth', args: ['skills', 'add', 'firthstack/firth', '-s', 'firth', ...AGENT_FLAGS] },
]

// Install the related agent skills once per linked project. No-op unless deps.run is set
// (production wires the real runner; tests inject a fake; other command tests omit it → no-op,
// so nothing is spawned). Convenience only — never blocks or fails the host command.
export async function ensureSkills(deps: SkillsDeps): Promise<void> {
  const run = deps.run
  if (!run) return
  try {
    const link = readProjectLink(deps.cwd)
    if (!link || link.skillsInstalled) return // not linked yet, or already done
    deps.print('installing related agent skills (neon, tigris, better-auth, firth) via `npx skills add` …')
    for (const s of SKILLS) {
      const r = await run('npx', s.args, true) // streamed so the user sees progress
      deps.print(r.ok ? `  ${s.label} ✓` : `  ${s.label} failed — add manually: npx ${s.args.join(' ')}`)
    }
    // keep the installed (regenerable) skill folders out of the developer's git history
    const added = ensureGitignore(deps.cwd, SKILL_DIRS)
    if (added.length) deps.print(`  .gitignore += ${added.join(', ')}`)
    markSkillsInstalled(deps.cwd) // mark done even on partial failure so we don't re-run every command
  } catch {
    /* convenience only — never block the command */
  }
}
