import re, glob, os
import opencc

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
TARGETS = []
for pat in ("tools/*.mjs", "tools/*.js", "mock-llm/*.mjs"):
    TARGETS += glob.glob(os.path.join(ROOT, pat))
TARGETS = [p for p in TARGETS if not os.path.basename(p).startswith(".t2s")]

cc = opencc.OpenCC("t2s")
CJK_RUN = re.compile(r"[\u2e80-\u9fff\uf900-\ufaff\u3000-\u303f\uff01-\uff5e\uffe0-\uffee]+")
KANA = re.compile(r"[\u3040-\u30ff\u31f0-\u31ff\uff65-\uff9f]")


def conv_run(m):
    s = m.group(0)
    if KANA.search(s):
        return s
    return cc.convert(s)


for path in TARGETS:
    src = open(path, encoding="utf-8").read()
    new = CJK_RUN.sub(conv_run, src)
    if new == src:
        print(f"skip (no change): {os.path.basename(path)}")
        continue
    ascii_old = "".join(c for c in src if ord(c) < 128)
    ascii_new = "".join(c for c in new if ord(c) < 128)
    assert ascii_old == ascii_new, f"ASCII changed in {path}"
    open(path, "w", encoding="utf-8", newline="").write(new)
    print(f"converted: {os.path.basename(path)}")
