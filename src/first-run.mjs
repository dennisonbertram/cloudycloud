// remoteDialogSeen + remoteControlAtStartup: on a fresh home, claude --remote-control does not connect until a one-time consent dialog is accepted; both keys verified live 2026-11-27.
// Marks Claude Code's first-run screens as done in ~/.claude.json, trusts ~/repo, and sets skipDangerousModePermissionPrompt in
// ~/.claude/settings.json so the one-time bypass-mode confirmation never appears (#88). Keys found live on a coordinator.
export const FIRST_RUN_SCRIPT = `const fs=require('fs'),f=(process.env.CLAUDE_CONFIG_DIR||process.env.HOME)+'/.claude.json';
const j=fs.existsSync(f)?JSON.parse(fs.readFileSync(f,'utf8')):{};
Object.assign(j,{hasCompletedOnboarding:true,theme:j.theme||'dark',hasSeenAutoDefaultNotice:true,remoteDialogSeen:true,remoteControlAtStartup:true,fullscreenUpsellSeenCount:Math.max(3,j.fullscreenUpsellSeenCount||0)});
const p=process.env.HOME+'/repo';j.projects=j.projects||{};
j.projects[p]={...(j.projects[p]||{}),hasTrustDialogAccepted:true,hasCompletedProjectOnboarding:true};
fs.writeFileSync(f,JSON.stringify(j,null,2),{mode:0o600});
const d=process.env.HOME+'/.claude',g=d+'/settings.json';fs.mkdirSync(d,{recursive:true});
let u={};try{const t=fs.readFileSync(g,'utf8');try{const x=JSON.parse(t);if(x&&typeof x==='object'&&!Array.isArray(x))u=x;else fs.writeFileSync(g+'.bak',t)}catch{fs.writeFileSync(g+'.bak',t)}}catch{}
u.skipDangerousModePermissionPrompt=true;
fs.writeFileSync(g,JSON.stringify(u,null,2),{mode:0o600});`;

