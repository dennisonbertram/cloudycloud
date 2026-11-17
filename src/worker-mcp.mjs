// The MCP servers a Claude worker starts with: the machine image's own (~/.claude.json) minus `instabox`, which has no sign-in
// on the box, plus the servers the user shared (mcp.json). Shared entries win a name clash (#145).
export const mergeMcp = (image, shared) => {
  const own = (x) => (x && typeof x.mcpServers === 'object' && x.mcpServers && !Array.isArray(x.mcpServers) ? x.mcpServers : {});
  const { instabox, ...rest } = own(image);
  return { mcpServers: { ...rest, ...own(shared) } };
};

// Runs on the machine: `node -e <script> <out> <shared>`. Unreadable files count as empty; contents are never printed.
// It removes any old file first (no stale config from an earlier turn) and exits non-zero only if it cannot write, so the shell fallback runs.
export const MERGE_MCP_SCRIPT = `const fs=require('fs');const merge=${mergeMcp.toString()};
const read=(f)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch{return {}}};
const out=process.argv[1];try{fs.rmSync(out,{force:true})}catch{}
let body;try{body=JSON.stringify(merge(read(process.env.HOME+'/.claude.json'),read(process.argv[2])))}catch{body='{"mcpServers":{}}'}
fs.writeFileSync(out,body,{mode:0o600});fs.chmodSync(out,0o600);`;
