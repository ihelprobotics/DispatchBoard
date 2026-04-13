from pathlib import Path
path=Path('backend/src/index.ts')
with path.open('r',encoding='utf-8') as f:
    lines=list(f)
for target in ['function normalizeParsedOrder','async function parseWithOpenRouter','async function pollImap']:
    for idx,line in enumerate(lines,1):
        if target in line:
            print(f"{target} -> {idx}")
            break
