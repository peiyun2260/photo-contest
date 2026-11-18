"""把思源宋體（Source Han Serif TW SemiBold）縮成只含標題用到的字。

用法：
  python3 scripts/subset-title-font.py path/to/SourceHanSerifTW-SemiBold.otf
改了 app.js / index.html 裡的標題文字後，重跑一次即可。

字型授權是 SIL OFL 1.1，「Source」是保留字型名稱，
所以子集化後的字型改名為 PhotoContestTitle（授權全文見 public/fonts/OFL.txt）。
"""
import re
import sys
from pathlib import Path

from fontTools import subset
from fontTools.ttLib import TTFont

ROOT = Path(__file__).resolve().parent.parent
SRC = Path(sys.argv[1])
OUT = ROOT / 'public' / 'fonts' / 'title-serif.woff2'
NAME = 'PhotoContestTitle'

# 從程式裡抓出所有 hero 標題字串，避免漏字
text = (ROOT / 'public' / 'index.html').read_text() + (ROOT / 'public' / 'app.js').read_text()
titles = re.findall(r'id="hero-title">(.*?)</h1>', text)
titles += re.findall(r"setHTML\(\$\('hero-title'\),[\s\S]*?;", text)
chars = set(''.join(re.sub(r'<[^>]+>', '', t) for t in titles))
chars = {c for c in chars if ord(c) > 0x2E7F} | set('！？，。、')  # 只收中日文字與全形標點
chars |= set('要')  # 備用：「我們要結婚了」

opts = subset.Options()
opts.flavor = 'woff2'
opts.layout_features = ['*']
opts.name_IDs = [0, 1, 2, 3, 4, 5, 6]
opts.notdef_outline = True
font = subset.load_font(str(SRC), opts)
sub = subset.Subsetter(opts)
sub.populate(text=''.join(sorted(chars)))
sub.subset(font)

for rec in font['name'].names:
    if rec.nameID in (1, 4, 16, 21):
        rec.string = NAME
    elif rec.nameID == 3:
        rec.string = f'{NAME}-SemiBold-subset'
    elif rec.nameID == 6:
        rec.string = f'{NAME}-SemiBold'
font.save(str(OUT))
print(f'{OUT.relative_to(ROOT)}: {OUT.stat().st_size} bytes, {len(chars)} 字 → {"".join(sorted(chars))}')
