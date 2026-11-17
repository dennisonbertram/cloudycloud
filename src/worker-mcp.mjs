// The MCP servers a Claude worker starts with: the machine image's own (~/.claude.json) minus `instabox`, which has no sign-in
// on the box, plus the servers the user shared (mcp.json). Shared entries win a name clash (#145).
export const mergeMcp = (image, shared) => {
  const own = (x) => (x && typeof x.mcpServers === 'object' && x.mcpServers && !Array.isArray(x.mcpServers) ? x.mcpServers : {});
  const { instabox, ...rest } = own(image);
  return { mcpServers: { ...rest, ...own(shared) } };
};

// Runs on the machine: `node -e <script> <out> <shared>`. Unreadable files count as empty; contents are never printed.
// It must not use single quotes (the command wraps it in them) and must never throw.
export const MERGE_MCP_SCRIPT = `const fs=require('fs');const merge=${mergeMcp.toString()};
const read=(f)=>{try{return JSON.parse(fs.readFileSync(f,'utf8'))}catch{return {}}};
try{fs.writeFileSync(process.argv[1],JSON.stringify(merge(read(process.env.HOME+'/.claude.json'),read(process.argv[2]))),{mode:0o600})}catch{}`;
