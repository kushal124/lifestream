import json
import math
import os

from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))

PHI = (1 + 5 ** 0.5) / 2
V = (1.1487, 0.1906)
PHI_TOP = 2.9671
PHI_RIGHT = 1.9430
PHI_OUT = 3.6576
GATHER_R, GATHER_SOFT = 0.2343, 0.5585
AMP, WAVES, PHASE = 0.11, 1.25, 4.1552
TIP_R, TIP_SOFT = 0.19, 1.7
STREAMS = (1.0, 1 / PHI, 1 / PHI ** 2)
SLIVERS = (1 / PHI, 1 / PHI ** 3)
SMALL = 1.75

CREVASSE, ICE, ICE_LIGHT = '#08141A', '#DDEEF2', '#EEF5F7'

W3, W2, W1 = STREAMS
S2, S1 = SLIVERS
TOTAL = W3 + S2 + W2 + S1 + W1
CENTRES = {'s2': W3 + S2 / 2, 's1': W3 + S2 + W2 + S1 / 2}
OMEGA = 2 * math.pi * WAVES / (math.log(1.35) - math.log(0.05))
RHO0, RHO1 = math.log(0.012), math.log(1.75)


def angle(pos, rho):
    """The angle of the lane boundary at cumulative position pos, at distance e^rho from V."""
    gather = 1 / (1 + math.exp(-(rho - math.log(GATHER_R)) / GATHER_SOFT))
    far = PHI_RIGHT + (PHI_TOP - PHI_RIGHT) * pos / TOTAL
    return PHI_OUT + (far - PHI_OUT) * gather + AMP * gather * math.sin(OMEGA * rho + PHASE)


def edge(pos, rho0, rho1, open_from=None, half=0.0, segs=8, bend=None):
    """An edge as cubic segments [p0, c1, c2, p1, c1, c2, p2, ...] with exact tangents.
    A sliver edge sits half its width off its centre, opening from a point at open_from; bend(rho), if
    given, turns the edge about V by that many radians at each distance (the loading mark's sway)."""
    def point(rho):
        offset = half * max(0.0, math.tanh((rho - open_from) / TIP_SOFT)) if open_from is not None else 0.0
        r, a = math.exp(rho), angle(pos + offset, rho) + (bend(rho) if bend else 0.0)
        return (V[0] + r * math.cos(a), V[1] + r * math.sin(a))
    def tangent(rho, h=1e-5):
        a, b = point(rho - h), point(rho + h)
        return ((b[0] - a[0]) / (2 * h), (b[1] - a[1]) / (2 * h))
    pts = [point(rho0)]
    for i in range(segs):
        ra, rb = rho0 + (rho1 - rho0) * i / segs, rho0 + (rho1 - rho0) * (i + 1) / segs
        pa, pb, da, db, k = point(ra), point(rb), tangent(ra), tangent(rb), (rb - ra) / 3
        pts += [(pa[0] + da[0] * k, pa[1] + da[1] * k), (pb[0] - db[0] * k, pb[1] - db[1] * k), pb]
    return pts


def darks(small=False):
    """The four dark shapes in the unit square, as outlines: lists of ('M'|'L', p) and ('C', c1, c2, p)."""
    def run(pts):
        return [('M', pts[0])] + [('C', pts[i], pts[i + 1], pts[i + 2]) for i in range(1, len(pts), 3)]
    top, right = edge(TOTAL, RHO0, RHO1), edge(0.0, RHO0, RHO1)
    shapes = [run(top) + [('L', (-0.3, -0.3)), ('L', (1.6, -0.3))],
              run(right) + [('L', (1.6, 1.6)), ('L', (1.6, right[0][1]))]]
    scale = SMALL if small else 1.0
    for name, width in (('s1', S1), ('s2', S2)):
        rt = math.log(TIP_R)
        hi = edge(CENTRES[name], rt, RHO1, rt, +width / 2 * scale)
        lo = edge(CENTRES[name], rt, RHO1, rt, -width / 2 * scale)
        shapes.append(run(hi[::-1]) + run(lo)[1:])
    return shapes


def squircle(x, y, s, r):
    """A rounded square with continuous-looking corners, as an outline."""
    k = 0.38
    return [('M', (x + r, y)), ('L', (x + s - r, y)), ('C', (x + s - r * k, y), (x + s, y + r * k), (x + s, y + r)),
            ('L', (x + s, y + s - r)), ('C', (x + s, y + s - r * k), (x + s - r * k, y + s), (x + s - r, y + s)),
            ('L', (x + r, y + s)), ('C', (x + r * k, y + s), (x, y + s - r * k), (x, y + s - r)),
            ('L', (x, y + r)), ('C', (x, y + r * k), (x + r * k, y), (x + r, y))]


def path_d(outline, f):
    d = []
    for cmd in outline:
        d.append(cmd[0] + ' ' + ' '.join('%.2f %.2f' % f(p) for p in cmd[1:]))
    return ' '.join(d) + ' Z'


def polygon(outline, f, steps=24):
    pts, cur = [], None
    for cmd in outline:
        if cmd[0] in 'ML':
            cur = cmd[1]; pts.append(f(cur))
        else:
            c1, c2, p = cmd[1:]
            for i in range(1, steps + 1):
                t = i / steps; u = 1 - t
                pts.append(f(tuple(u**3 * a + 3 * u * u * t * b + 3 * u * t * t * c + t**3 * d
                                   for a, b, c, d in zip(cur, c1, c2, p))))
            cur = p
    return pts


def svg(ground, streams, box, small=False):
    x, y, s, r = box
    f = lambda p: (x + p[0] * s, y + p[1] * s)
    shape = path_d(squircle(x, y, s, r) if r else [('M', (x, y)), ('L', (x + s, y)), ('L', (x + s, y + s)), ('L', (x, y + s))], lambda p: p)
    dark = ''.join(f'<path d="{path_d(o, f)}"/>' for o in darks(small))
    if ground is None:
        body = (f'<mask id="m"><path d="{shape}" fill="#fff"/><g fill="#000">{dark}</g></mask>'
                f'<rect x="{x}" y="{y}" width="{s}" height="{s}" fill="{streams}" mask="url(#m)"/>')
    else:
        body = (f'<clipPath id="t"><path d="{shape}"/></clipPath>'
                f'<g clip-path="url(#t)"><path d="{shape}" fill="{streams}"/><g fill="{ground}">{dark}</g></g>')
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024" width="1024" height="1024">{body}</svg>\n'


def png(ground, streams, box, pixels):
    """Pixels, drawn 4x and reduced. Full-bleed designs are opaque; tiles have clear corners."""
    n = pixels * 4
    x, y, s, r = (v * n / 1024 if v is not None else None for v in box)
    f = lambda p: (x + p[0] * s, y + p[1] * s)
    art = Image.new('RGB', (n, n), streams)
    draw = ImageDraw.Draw(art)
    for o in darks(small=pixels <= 32):
        draw.polygon(polygon(o, f), fill=ground)
    if r is None:
        return art.resize((pixels, pixels), Image.LANCZOS)
    mask = Image.new('L', (n, n), 0)
    ImageDraw.Draw(mask).polygon(polygon(squircle(x, y, s, r), lambda p: p), fill=255)
    out = Image.new('RGBA', (n, n), (0, 0, 0, 0))
    out.paste(art, (0, 0), mask)
    return out.resize((pixels, pixels), Image.LANCZOS)


IOS = (0, 0, 1024, None)
MACOS = (100, 100, 824, 185)
TILE = (0, 0, 1024, 230)
MARK = (40, 40, 944, 212)


def swift_block():
    """The Mac icon's shapes for make-icon.swift, in unit coordinates."""
    unit = lambda p: p
    lines = [f'let logoGround = "{CREVASSE}"', f'let logoStreams = "{ICE}"',
             f'let logoTile = "{path_d(squircle(*MACOS), lambda p: p)}"', 'let logoDarks = [']
    lines += [f'    "{path_d(o, unit)}",' for o in darks()]
    lines += [']', 'let logoDarksSmall = [']
    lines += [f'    "{path_d(o, unit)}",' for o in darks(small=True)]
    lines += [']']
    return '\n'.join(lines)


SWAY = 0.15
SWAY_WAVE = 2.6
SWAY_LAG = 0.07
SWAY_FROM, SWAY_TO = 0.12, 1.4
LOADER_FRAMES, LOADER_SEGS = 30, 6


def loader_streams(t=None):
    """The three streams (right, middle, top) at moment t of a cycle, or at rest, each as its points in
    drawing order: one bank from V outward [p0, c1, c2, p1, ...], then the other back to V."""
    rt = math.log(TIP_R)
    banks = [((0.0, None, 0.0), (CENTRES['s2'], rt, -S2 / 2 * SMALL)),
             ((CENTRES['s2'], rt, S2 / 2 * SMALL), (CENTRES['s1'], rt, -S1 / 2 * SMALL)),
             ((CENTRES['s1'], rt, S1 / 2 * SMALL), (TOTAL, None, 0.0))]
    out = []
    for j, (lo, hi) in enumerate(banks):
        def bend(rho, j=j):
            if t is None:
                return 0.0
            u = min(1.0, max(0.0, (rho - math.log(SWAY_FROM)) / (math.log(SWAY_TO) - math.log(SWAY_FROM))))
            return SWAY * u * u * math.sin(2 * math.pi * (t - j * SWAY_LAG) - SWAY_WAVE * u)
        a = edge(lo[0], RHO0, RHO1, lo[1], lo[2], LOADER_SEGS, bend)
        b = edge(hi[0], RHO0, RHO1, hi[1], hi[2], LOADER_SEGS, bend)
        out.append(a + b[::-1])
    return out


def loader_d(streams):
    def one(pts):
        n = 1 + 3 * LOADER_SEGS
        f = lambda p: '%.1f %.1f' % (p[0] * 100, p[1] * 100)
        bank = lambda q: 'M' + f(q[0]) + ''.join('C' + ' '.join(f(x) for x in q[i:i + 3]) for i in range(1, n, 3))
        return bank(pts[:n]) + 'L' + bank(pts[n:])[1:] + 'Z'
    return ''.join(one(p) for p in streams)


def loader_svgs():
    """The dashboard's masks: the mark swaying (SMIL, one cycle of duration-breath) and the mark at rest."""
    tokens = json.load(open(os.path.join(ROOT, 'design/tokens.json')))
    breath = next(t['value'] for t in tokens['duration']['tokens'] if t['name'] == 'duration-breath')
    tile = path_d(squircle(0, 0, 100, 100 * TILE[3] / TILE[2]), lambda p: p)
    head = (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><clipPath id="t"><path d="{tile}"/></clipPath>'
            '<g clip-path="url(#t)">')
    frames = [loader_d(loader_streams(i / LOADER_FRAMES)) for i in range(LOADER_FRAMES + 1)]
    moving = (head + f'<path d="{frames[0]}"><animate attributeName="d" dur="{breath}" repeatCount="indefinite" '
              f'values="{";".join(frames)}"/></path></g></svg>\n')
    still = head + f'<path d="{loader_d(loader_streams())}"/></g></svg>\n'
    return moving, still


def loader_swift():
    """Cockpit's frames: each frame every stream's points in drawing order, in the tile's unit square."""
    nums = lambda streams: ' '.join('%.4f %.4f' % p for pts in streams for p in pts)
    frames = '\n'.join(f'        {nums(loader_streams(i / LOADER_FRAMES))}' for i in range(LOADER_FRAMES))
    return f"""import Foundation

enum LoadingMark {{
    static let segments = {LOADER_SEGS}
    static let tileRadius = {TILE[3] / TILE[2]:.4f}
    static let still = numbers(\"\"\"
        {nums(loader_streams())}
        \"\"\")
    static let frames = \"\"\"
{frames}
        \"\"\".split(separator: "\\n").map {{ numbers(String($0)) }}

    private static func numbers(_ line: String) -> [Double] {{
        line.split(separator: " ").compactMap {{ Double($0) }}
    }}
}}
"""


def write(rel, data):
    path = os.path.join(ROOT, rel)
    if isinstance(data, Image.Image):
        data.save(path)
    else:
        open(path, 'w').write(data)
    print(rel)


def main():
    marks = 'design/marks'
    write(f'{marks}/logo-ios-dark.svg', svg(CREVASSE, ICE, IOS))
    write(f'{marks}/logo-ios-light.svg', svg(ICE_LIGHT, CREVASSE, IOS))
    write(f'{marks}/logo-ios-tinted.svg', svg('#000000', '#FFFFFF', IOS))
    write(f'{marks}/logo-macos-dark.svg', svg(CREVASSE, ICE, MACOS))
    write(f'{marks}/logo-macos-light.svg', svg(ICE_LIGHT, CREVASSE, MACOS))
    write(f'{marks}/logo-tile.svg', svg(CREVASSE, ICE, TILE))
    write(f'{marks}/logo-mark-ice.svg', svg(None, ICE, MARK))
    write(f'{marks}/logo-mark-crevasse.svg', svg(None, CREVASSE, MARK))
    write(f'{marks}/logo-glyph.svg', svg(None, '#000000', (0, 0, 1024, 230), small=True))
    icons = 'ios-app/LifestreamCapture/Resources/Assets.xcassets/AppIcon.appiconset'
    write(f'{icons}/AppIcon.png', png(CREVASSE, ICE, IOS, 1024))
    write(f'{icons}/AppIcon-dark.png', png(CREVASSE, ICE, IOS, 1024))
    write(f'{icons}/AppIcon-tinted.png', png('#000000', '#FFFFFF', IOS, 1024).convert('L'))
    image = lambda name, appearance=None: dict({'filename': name, 'idiom': 'universal', 'platform': 'ios', 'size': '1024x1024'},
                                                **({'appearances': [{'appearance': 'luminosity', 'value': appearance}]} if appearance else {}))
    write(f'{icons}/Contents.json', json.dumps({'images': [image('AppIcon.png'), image('AppIcon-dark.png', 'dark'),
                                                           image('AppIcon-tinted.png', 'tinted')],
                                                'info': {'author': 'xcode', 'version': 1}}, indent=2) + '\n')
    for size in (16, 48, 128):
        write(f'extension/icons/icon-{size}.png', png(CREVASSE, ICE, TILE, size))
    write('dashboard/public/icon.svg', svg(CREVASSE, ICE, TILE))
    write('website/icon.svg', svg(CREVASSE, ICE, TILE))
    moving, still = loader_svgs()
    write('dashboard/public/loader.svg', moving)
    write('dashboard/public/loader-still.svg', still)
    write('design/swift/Sources/Cockpit/Components/LoadingMark.swift', loader_swift())
    swift = os.path.join(ROOT, 'macos-app/make-icon.swift')
    source = open(swift).read()
    start = source.index('let logoGround = ')
    end = source.index('\n]\n', source.index('let logoDarksSmall = [')) + 2
    write('macos-app/make-icon.swift', source[:start] + swift_block() + source[end:])


if __name__ == '__main__':
    main()
