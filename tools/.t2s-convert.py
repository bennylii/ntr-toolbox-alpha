import re, sys, shutil, difflib, os
import opencc

_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PATH = os.path.join(_ROOT, "NTR_ToolBox.user.js")
BAK = os.path.join(_ROOT, ".t2s-backup.user.js")
DIFF = os.path.join(_ROOT, ".t2s.diff")

cc = opencc.OpenCC("t2s")
CJK_RUN = re.compile(r"[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff01-\uff5e\uffe0-\uffee]+")
KANA = re.compile(r"[\u3040-\u30ff\u31f0-\u31ff\uff65-\uff9f]")

src = open(PATH, encoding="utf-8").read()
shutil.copyfile(PATH, BAK)

changed_runs = {"n": 0, "samples": []}


def conv_run(m):
    s = m.group(0)
    if KANA.search(s):
        return s
    out = cc.convert(s)
    if out != s:
        changed_runs["n"] += 1
        if len(changed_runs["samples"]) < 15:
            changed_runs["samples"].append((s, out))
    return out


new = CJK_RUN.sub(conv_run, src)

# 断言：ASCII 部分一字未动
ascii_old = "".join(c for c in src if ord(c) < 128)
ascii_new = "".join(c for c in new if ord(c) < 128)
assert ascii_old == ascii_new, "ASCII 被改动，转换有风险，已中止"

# 断言：含假名的行（KANA 常量）未变
kana_old = [l for l in src.splitlines() if KANA.search(l)]
kana_new = [l for l in new.splitlines() if KANA.search(l)]
assert kana_old == kana_new, "含假名的行被改动，已中止"

open(PATH, "w", encoding="utf-8", newline="").write(new)

diff = list(difflib.unified_diff(src.splitlines(), new.splitlines(), "before", "after", lineterm="", n=0))
changed_lines = sum(1 for l in diff if l.startswith("+") and not l.startswith("+++"))
open(DIFF, "w", encoding="utf-8", newline="").write("\n".join(diff))

print(f"changed runs: {changed_runs['n']}")
print(f"changed lines: {changed_lines}")
print("sample:", changed_runs["samples"][:6])
print(f"backup: {BAK}")
print(f"diff: {DIFF}")
