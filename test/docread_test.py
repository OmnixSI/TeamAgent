import codecs
import importlib.util
import json
import os
import pathlib
import struct
import subprocess
import sys
import tempfile
import unittest
import zipfile
from unittest import mock
from xml.sax.saxutils import escape

ROOT = pathlib.Path(__file__).parents[1]
spec = importlib.util.spec_from_file_location("docread", ROOT / "runner/docread.py")
docread = importlib.util.module_from_spec(spec)
spec.loader.exec_module(docread)


def make_pdf(path, pages=10, amount_page=3):
    """10-page PDF; page 3 carries a table and the total amount."""
    from reportlab.lib.pagesizes import A4
    from reportlab.pdfbase import pdfmetrics
    from reportlab.pdfbase.cidfonts import UnicodeCIDFont
    from reportlab.pdfgen import canvas
    from reportlab.platypus import Table

    pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
    c = canvas.Canvas(str(path), pagesize=A4)
    for i in range(1, pages + 1):
        c.setFont("STSong-Light", 12)
        c.drawString(72, 790, f"第 {i} 页 费用明细")
        c.drawString(72, 770, f"项目 A{i} 金额：{i}2,000.00 元")
        if i == amount_page:
            c.drawString(72, 750, "本页合计金额：12,345.67 元")
            table = Table([["项目", "金额"], ["服务器", "10,000.00"], ["运维", "2,345.67"]])
            table.wrapOn(c, 400, 100)
            table.drawOn(c, 72, 640)
        c.showPage()
    c.save()


def make_docx(path):
    from docx import Document

    d = Document()
    d.add_heading("季度报告", 0)
    d.add_paragraph("第一段：本季度交付稳定。")
    d.add_paragraph("第二段：预算剩余 12,345.67 元。")
    table = d.add_table(rows=2, cols=2)
    table.cell(0, 0).text = "项目"
    table.cell(0, 1).text = "金额"
    table.cell(1, 0).text = "服务器"
    table.cell(1, 1).text = "10,000.00"
    section = d.sections[0]
    section.header.paragraphs[0].text = "页眉：内部资料"
    section.footer.paragraphs[0].text = "页脚：财务部"
    d.save(str(path))


def make_pptx(path):
    from pptx import Presentation

    prs = Presentation()
    slide = prs.slides.add_slide(prs.slide_layouts[1])
    slide.shapes.title.text = "第一页标题"
    slide.placeholders[1].text = "要点一：预算 12,345.67 元"
    slide.notes_slide.notes_text_frame.text = "演讲备注：先讲金额"
    slide2 = prs.slides.add_slide(prs.slide_layouts[1])
    slide2.shapes.title.text = "第二页标题"
    slide2.placeholders[1].text = "要点二：下季度计划"
    prs.save(str(path))


def make_xlsx(path):
    """Minimal real XLSX: sheet1 inline strings + formula, sheet2 shared strings."""
    content_types = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>"""
    rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"""
    workbook = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="汇总" sheetId="1" r:id="rId1"/><sheet name="明细" sheetId="2" r:id="rId2"/></sheets>
</workbook>"""
    workbook_rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>"""
    shared = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="2" uniqueCount="2">
<si><t>季度</t></si><si><t>备注</t></si></sst>"""
    rows = "".join(
        f'<row r="{r}"><c r="A{r}" t="inlineStr"><is><t>项目{escape(str(r))}</t></is></c>'
        f'<c r="B{r}"><v>{r * 1000}</v></c></row>'
        for r in range(2, 7)
    )
    sheet1 = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:B7"/><sheetData>
<row r="1"><c r="A1" t="inlineStr"><is><t>项目</t></is></c><c r="B1" t="inlineStr"><is><t>金额</t></is></c></row>
{rows}
<row r="7"><c r="A7" t="inlineStr"><is><t>合计</t></is></c><c r="B7"><f>SUM(B2:B6)</f><v>15000</v></c></row>
</sheetData><mergeCells count="1"><mergeCell ref="A1:B1"/></mergeCells></worksheet>"""
    sheet2 = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:B2"/><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>
<row r="2"><c r="A2" t="s"><v>0</v></c><c r="B2"><v>0.5</v></c></row>
</sheetData></worksheet>"""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("xl/workbook.xml", workbook)
        z.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        z.writestr("xl/sharedStrings.xml", shared)
        z.writestr("xl/worksheets/sheet1.xml", sheet1)
        z.writestr("xl/worksheets/sheet2.xml", sheet2)


def make_zip_bomb(path, member="word/media/bomb.bin", size=120 * 1024 * 1024):
    """An OOXML-shaped zip that inflates to `size` bytes from a few hundred KB on disk."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        with z.open(member, "w") as entry:
            chunk = b"0" * (1024 * 1024)
            for _ in range(size // len(chunk)):
                entry.write(chunk)
            if size % len(chunk):
                entry.write(b"0" * (size % len(chunk)))


def make_declared_size_zip(path, declared=210 * 1024 * 1024):
    """A tiny zip whose central directory claims a huge uncompressed entry."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("xl/workbook.xml", "<workbook/>")
    raw = bytearray(path.read_bytes())
    offset, patched = 0, 0
    while True:
        start = raw.find(b"PK\x01\x02", offset)
        if start < 0:
            break
        raw[start + 24:start + 28] = struct.pack("<I", declared)
        patched += 1
        offset = start + 4
    assert patched, "the fixture must contain a central directory"
    path.write_bytes(bytes(raw))


def make_low_ratio_zip(path, members, extra=()):
    """OOXML-shaped zip with large XML members that compress only ~11x, not >100x.

    Each random byte becomes eight '0'/'1' chars carrying three random bits, so a
    40 MiB part is roughly 3.7 MiB on disk: too big for the XML cap, but far below
    the bomb ratio.
    """
    mask = bytes(i & 0x07 for i in range(256))
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        for name, data in extra:
            z.writestr(name, data)
        for name, size in members:
            with z.open(name, "w") as entry:
                entry.write(b"<root>")
                remaining = size - len(b"<root>") - len(b"</root>")
                while remaining > 0:
                    take = min(remaining, 8 * 1024 * 1024)
                    raw = os.urandom(max(1, (take + 7) // 8))
                    masked = raw.translate(mask)
                    chunk = bin(int.from_bytes(masked, "big"))[2:].zfill(len(masked) * 8).encode("ascii")[:take]
                    entry.write(chunk)
                    remaining -= len(chunk)
                entry.write(b"</root>")


def make_many_rows_xlsx(path, rows=6000, dimension=True):
    content_types = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"""
    rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"""
    workbook = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="大表" sheetId="1" r:id="rId1"/></sheets>
</workbook>"""
    workbook_rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"""
    sheet_rows = "".join(
        f'<row r="{r}"><c r="A{r}" t="inlineStr"><is><t>项目{r}</t></is></c>'
        f'<c r="B{r}"><v>{r}</v></c></row>'
        for r in range(1, rows + 1)
    )
    dimension_tag = f'<dimension ref="A1:B{rows}"/>' if dimension else ""
    sheet = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
{dimension_tag}<sheetData>{sheet_rows}</sheetData></worksheet>"""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("xl/workbook.xml", workbook)
        z.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        z.writestr("xl/worksheets/sheet1.xml", sheet)


def xlsx_column(index):
    name = ""
    index += 1
    while index:
        index, remainder = divmod(index - 1, 26)
        name = chr(65 + remainder) + name
    return name


def write_single_sheet_xlsx(path, sheet_xml):
    content_types = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"""
    rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"""
    workbook = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="表1" sheetId="1" r:id="rId1"/></sheets>
</workbook>"""
    workbook_rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
</Relationships>"""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("xl/workbook.xml", workbook)
        z.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        z.writestr("xl/worksheets/sheet1.xml", sheet_xml)


def make_wide_row_xlsx(path, cells=16_385):
    cell_xml = "".join(
        f'<c r="{xlsx_column(i)}1"><v>{i}</v></c>' for i in range(1, cells + 1)
    )
    sheet = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:{xlsx_column(cells)}1"/><sheetData><row r="1">{cell_xml}</row></sheetData></worksheet>"""
    write_single_sheet_xlsx(path, sheet)


def make_out_of_row_xlsx(path, count=100_001):
    sheet = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1"/><sheetData/>{'<x/>' * count}</worksheet>"""
    write_single_sheet_xlsx(path, sheet)


def make_docx_many_elements(path, count=2_000_001, member="word/document.xml"):
    """A docx-shaped zip with >2M small elements and low compression (random attrs)."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        with z.open(member, "w") as entry:
            entry.write(b"<document>")
            batch = 10000
            for base in range(0, count, batch):
                take = min(batch, count - base)
                raw = os.urandom(take * 2)
                entry.write(b"".join(
                    b'<p a="' + raw[i * 2:i * 2 + 2].hex().encode("ascii") + b'"/>'
                    for i in range(take)
                ))
            entry.write(b"</document>")


def make_large_sheet_xlsx(path, rows, cols, text=False, relationship_type="worksheet"):
    """A real large worksheet, streamed so the fixture itself stays cheap.

    `text=True` uses unique 8-hex inline strings, which keeps the deflate ratio
    realistic (well below the 100x bomb threshold) while making the part >32 MiB.
    """
    content_types = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
</Types>"""
    rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"""
    workbook = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="大表" sheetId="1" r:id="rId1"/></sheets>
</workbook>"""
    workbook_rels = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/{relationship_type}" Target="worksheets/sheet1.xml"/>
</Relationships>"""
    last_column = xlsx_column(cols - 1)
    header = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:{last_column}{rows}"/><sheetData>"""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("xl/workbook.xml", workbook)
        z.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        with z.open("xl/worksheets/sheet1.xml", "w") as entry:
            entry.write(header.encode("utf-8"))
            for base in range(1, rows + 1, 2000):
                chunk = []
                for r in range(base, min(base + 2000, rows + 1)):
                    cells = []
                    for c in range(1, cols + 1):
                        reference = f"{xlsx_column(c - 1)}{r}"
                        if text:
                            token = f"{(r * 2654435761 + c * 40503) & 0xffffffff:08x}"
                            cells.append(
                                f'<c r="{reference}" t="inlineStr"><is><t>{token}</t></is></c>'
                            )
                        else:
                            cells.append(f'<c r="{reference}"><v>{(r * 37 + c * 101) % 100000}</v></c>')
                    chunk.append(f'<row r="{r}">{"".join(cells)}</row>')
                entry.write("".join(chunk).encode("utf-8"))
            entry.write(b"</sheetData></worksheet>")


def make_shared_strings_xlsx(path, count=1_000_000, garbage=0, si_flood=0):
    """An XLSX with shared strings, plus optional si-external or in-si element garbage."""
    content_types = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
</Types>"""
    rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>"""
    workbook = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets><sheet name="字符串" sheetId="1" r:id="rId1"/></sheets>
</workbook>"""
    workbook_rels = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>
</Relationships>"""
    sheet = """<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1:B2"/><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>999999</v></c></row>
</sheetData></worksheet>"""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", content_types)
        z.writestr("_rels/.rels", rels)
        z.writestr("xl/workbook.xml", workbook)
        z.writestr("xl/_rels/workbook.xml.rels", workbook_rels)
        z.writestr("xl/worksheets/sheet1.xml", sheet)
        with z.open("xl/sharedStrings.xml", "w") as entry:
            unique = max(count, 1)
            entry.write(
                f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n'
                f'<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
                f'count="{unique}" uniqueCount="{unique}">'.encode("utf-8")
            )
            if si_flood:
                entry.write(b"<si>")
                for base in range(0, si_flood, 5000):
                    chunk = "".join(
                        f"<x{i:x}/>" for i in range(base, min(base + 5000, si_flood))
                    )
                    entry.write(chunk.encode("ascii"))
                entry.write(b"</si>")
            else:
                for base in range(0, count, 5000):
                    chunk = []
                    for i in range(base, min(base + 5000, count)):
                        token = f"{(i * 2654435761) & 0xffffffff:08x}"
                        chunk.append(f"<si><t>{token}</t></si>")
                    entry.write("".join(chunk).encode("utf-8"))
            if garbage:
                for base in range(0, garbage, 5000):
                    chunk = "".join(
                        f"<x{i:x}/>" for i in range(base, min(base + 5000, garbage))
                    )
                    entry.write(chunk.encode("ascii"))
            entry.write(b"</sst>")


def make_wide_tag_docx(path, attrs=2_500_000):
    """A <28 MiB docx part whose only start tag carries 2.5M attributes."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        with z.open("word/document.xml", "w") as entry:
            entry.write(b'<?xml version="1.0" encoding="UTF-8"?><document')
            batch = 50_000
            for base in range(0, attrs, batch):
                entry.write("".join(
                    f' a{i:x}="x"' for i in range(base, min(base + batch, attrs))
                ).encode("ascii"))
            # The leading '>' closes the giant start tag; the rest is the end tag.
            entry.write(b"></document>")


def make_long_text_node_docx(path, size=5 * 1024 * 1024):
    """A docx part with one XML text node larger than the 4 MiB token cap."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        with z.open("word/document.xml", "w") as entry:
            entry.write(b"<document><t>")
            remaining = size
            while remaining:
                take = min(remaining, 65536)
                entry.write(os.urandom(take).hex().encode("ascii")[:take])
                remaining -= take
            entry.write(b"</t></document>")


def make_gt_value_tag_docx(path, attrs=2_500_000):
    """A <28 MiB part whose single start tag has 2.5M attributes, every value `>`."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        with z.open("word/document.xml", "w") as entry:
            entry.write(b'<?xml version="1.0" encoding="UTF-8"?><document')
            batch = 50_000
            for base in range(0, attrs, batch):
                entry.write("".join(
                    f' a{i:x}=">"' for i in range(base, min(base + batch, attrs))
                ).encode("ascii"))
            entry.write(b"></document>")


def make_docx_main_under_worksheets(path, paragraphs=1_200_000):
    """A docx whose main part sits at xl/worksheets/a.xml and carries >2M elements.

    Each paragraph gets a random 4-hex attribute so the part stays under 32 MiB and
    below the 100x compression ratio (only the element count can reject it).
    """
    tokens = os.urandom(2 * paragraphs).hex()
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        with z.open("xl/worksheets/a.xml", "w") as entry:
            entry.write(
                b'<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>'
            )
            entry.write(b"<w:row/>" * 5001)
            chunk = []
            for index in range(paragraphs):
                token = tokens[index * 4:(index + 1) * 4]
                chunk.append(f'<w:p a="{token}"><w:r/></w:p>')
                if len(chunk) == 5000:
                    entry.write("".join(chunk).encode("ascii"))
                    chunk = []
            if chunk:
                entry.write("".join(chunk).encode("ascii"))
            entry.write(b"</w:body></w:document>")


def make_encoded_xml_docx(path, encoding, bom=b"", size=34 * 1024 * 1024):
    """A docx-shaped XML part in UTF-16BE (no BOM) or UTF-32 (with BOM)."""
    head = (
        '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">'
        "<w:body>"
    )
    encoded = bom + head.encode(encoding)
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        z.writestr("[Content_Types].xml", "<Types/>")
        with z.open("word/document.bin", "w") as entry:
            entry.write(encoded)
            remaining = size - len(encoded)
            while remaining > 0:
                take = min(remaining, 65536)
                entry.write(os.urandom(take))
                remaining -= take


class DocReadTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = pathlib.Path(self.tmp.name) / "inputs"
        self.root.mkdir()
        make_pdf(self.root / "report.pdf")
        make_docx(self.root / "report.docx")
        make_pptx(self.root / "deck.pptx")
        make_xlsx(self.root / "book.xlsx")
        (self.root / "表格.csv").write_text("项目,金额\n服务器,10000\n运维,2345.67\n", encoding="utf-8-sig")
        (self.root / "旧表.csv").write_bytes("项目;金额\n服务器;10000\n".encode("gb18030"))
        with zipfile.ZipFile(self.root / "包.zip", "w") as z:
            z.writestr("a.txt", "hello")
            z.writestr("dir/b.txt", "world")

    def tearDown(self):
        self.tmp.cleanup()

    def read(self, name, **kw):
        return docread.read_document(name, root=self.root, **kw)

    # --- 10-page PDF -------------------------------------------------------
    def test_pdf_reports_page_count_and_page_sizes(self):
        out = self.read("report.pdf")
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["kind"], "pdf")
        self.assertEqual(len(out["pages"]), 10)
        self.assertEqual([p["page"] for p in out["pages"]], list(range(1, 11)))
        self.assertIn("===== 第 3 页 =====", out["text"])
        self.assertIn("===== 第 10 页 =====", out["text"])

    def test_page_question_returns_page_number_and_original_line(self):
        out = self.read("report.pdf", question="第3页的金额是多少")
        self.assertTrue(out["ok"], out)
        self.assertTrue(out["hits"], "question should locate page 3")
        first = out["hits"][0]
        self.assertEqual(first["page"], 3)
        self.assertIn("第 3 页", first["label"])
        self.assertIn("12,345.67", first["text"])
        # An amount from another page must not be presented as page 3.
        self.assertNotIn("42,000.00", first["text"])
        self.assertIn("本页合计金额", first["text"])

    def test_question_without_page_still_ranks_pages(self):
        out = self.read("report.pdf", question="合计金额")
        self.assertTrue(out["hits"])
        self.assertIn(out["hits"][0]["page"], (3, 4, 5, 6, 7, 8, 9, 10))

    def test_question_on_missing_page_returns_that_page_not_a_guess(self):
        out = self.read("report.pdf", question="第 11 页的金额")
        self.assertTrue(out["ok"])
        self.assertEqual(out["hits"], [])

    # --- DOCX -------------------------------------------------------------
    def test_docx_reads_paragraphs_tables_header_footer(self):
        out = self.read("report.docx")
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["kind"], "docx")
        for text in ("季度报告", "本季度交付稳定", "预算剩余 12,345.67", "服务器", "页眉：内部资料", "页脚：财务部"):
            self.assertIn(text, out["text"])
        self.assertEqual(out["pages"], [])
        self.assertEqual(out["sheets"], [])

    # --- XLSX -------------------------------------------------------------
    def test_xlsx_sheet_names_and_formulas(self):
        out = self.read("book.xlsx")
        self.assertTrue(out["ok"], out)
        names = [s["name"] for s in out["sheets"]]
        self.assertEqual(names, ["汇总", "明细"])
        summary = out["sheets"][0]
        self.assertEqual([f["cell"] for f in summary["formulas"]], ["B7"])
        self.assertEqual(summary["formulas"][0]["formula"], "=SUM(B2:B6)")
        self.assertEqual(summary["merged"], ["A1:B1"])
        self.assertEqual([s["name"] for s in out["sheets"] if s["formulas"]], ["汇总"])
        self.assertIn("汇总!B7", out["text"])
        self.assertIn("=SUM(B2:B6)", out["text"])

    def test_xlsx_shared_strings_are_resolved(self):
        out = self.read("book.xlsx", question="备注")
        self.assertTrue(out["ok"], out)
        self.assertIn("季度", out["text"])
        self.assertIn("备注", out["text"])
        self.assertTrue(out["hits"])

    def test_xlsx_question_points_at_sheet(self):
        out = self.read("book.xlsx", question="哪个单元格是合计金额")
        self.assertTrue(out["hits"])
        self.assertEqual(out["hits"][0]["label"], "汇总")

    # --- PPTX -------------------------------------------------------------
    def test_pptx_reads_slides_and_notes(self):
        out = self.read("deck.pptx")
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["kind"], "pptx")
        self.assertEqual(len(out["pages"]), 2)
        self.assertIn("第一页标题", out["text"])
        self.assertIn("演讲备注：先讲金额", out["text"])
        self.assertIn("第二页标题", out["text"])

    # --- CSV / ZIP --------------------------------------------------------
    def test_csv_utf8_and_gb18030(self):
        out = self.read("表格.csv")
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["kind"], "csv")
        self.assertIn("服务器", out["text"])
        self.assertIn("2345.67", out["text"])
        old = self.read("旧表.csv")
        self.assertTrue(old["ok"], old)
        self.assertIn("服务器", old["text"])
        self.assertNotIn("�", old["text"])

    def test_zip_lists_entries_without_extracting(self):
        before = set(p.name for p in self.root.iterdir())
        out = self.read("包.zip")
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["kind"], "zip")
        self.assertIn("a.txt", out["text"])
        self.assertIn("dir/b.txt", out["text"])
        self.assertEqual(set(p.name for p in self.root.iterdir()), before)

    def test_ooxml_zip_bomb_is_rejected_before_parsing(self):
        make_zip_bomb(self.root / "bomb.docx")
        out = self.read("bomb.docx")
        self.assertFalse(out["ok"], out)
        self.assertEqual(out["error_kind"], "too_large")
        self.assertIn("压缩比", out["error"])
        self.assertIn("word/media/bomb.bin", out["error"])

    def test_ooxml_declared_uncompressed_total_over_limit_is_rejected(self):
        make_declared_size_zip(self.root / "huge.xlsx")
        out = self.read("huge.xlsx")
        self.assertFalse(out["ok"], out)
        self.assertEqual(out["error_kind"], "too_large")
        self.assertIn("解压后", out["error"])
        self.assertIn("200", out["error"])

    def test_ooxml_rejects_xml_member_over_32_mib_at_low_compression(self):
        # A Python-docx XML part: 40 MiB uncompressed, ~2 MiB compressed (ratio ~20),
        # so the bomb-ratio rule does not catch it; the XML cap must.
        make_low_ratio_zip(self.root / "wide.docx", [("word/document.xml", 40 * 1024 * 1024)])
        with zipfile.ZipFile(self.root / "wide.docx") as archive:
            info = archive.getinfo("word/document.xml")
        self.assertGreater(info.file_size, 32 * 1024 * 1024)
        self.assertLess(info.compress_size, 4 * 1024 * 1024)
        self.assertLess(info.file_size / info.compress_size, 100)
        out = self.read("wide.docx")
        self.assertFalse(out["ok"], out)
        self.assertEqual(out["error_kind"], "too_large")
        self.assertIn("XML 单文件上限", out["error"])
        self.assertIn("32", out["error"])

    def test_ooxml_rejects_xml_total_over_48_mib(self):
        make_low_ratio_zip(self.root / "total.docx", [
            ("word/document.xml", 17 * 1024 * 1024),
            ("word/styles.xml", 17 * 1024 * 1024),
            ("word/numbering.xml", 17 * 1024 * 1024),
        ])
        out = self.read("total.docx")
        self.assertFalse(out["ok"], out)
        self.assertEqual(out["error_kind"], "too_large")
        self.assertIn("合计", out["error"])
        self.assertIn("48", out["error"])

    def test_guard_allows_large_worksheet_member(self):
        # Worksheets are exempt from the 32/48 MiB XML caps: a real 75k x 10 sheet
        # is ~43 MiB and must reach the 5000-row truncation path.
        make_large_sheet_xlsx(self.root / "wide.xlsx", rows=75_000, cols=10, text=True)
        with zipfile.ZipFile(self.root / "wide.xlsx") as archive:
            info = archive.getinfo("xl/worksheets/sheet1.xml")
        self.assertGreater(info.file_size, 40 * 1024 * 1024)
        self.assertLess(info.file_size / info.compress_size, 100)
        self.assertGreater(docread._guard_ooxml(self.root / "wide.xlsx"), 40 * 1024 * 1024)

    def test_docx_main_under_worksheets_is_not_exempt(self):
        # A docx part at xl/worksheets/a.xml must not inherit the xlsx streaming
        # exemption: 1.2M paragraphs are 2.4M elements and must hit the 2M budget.
        make_docx_main_under_worksheets(self.root / "fake-worksheet.docx")
        with zipfile.ZipFile(self.root / "fake-worksheet.docx") as archive:
            info = archive.getinfo("xl/worksheets/a.xml")
        self.assertLess(info.file_size, 32 * 1024 * 1024)
        out = self.read("fake-worksheet.docx")
        self.assertFalse(out["ok"], out)
        self.assertEqual(out["error_kind"], "too_large")
        self.assertIn("XML 元素", out["error"])
        self.assertIn("2000000", out["error"])

    def _styles_exempt_xlsx(self, name, junk):
        write_single_sheet_xlsx(
            self.root / name,
            '<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
            '<sheetData><row r="1"><c r="A1"><v>1</v></c></row></sheetData></worksheet>',
        )
        src = self.root / name
        out = self.root / ("rewrite-" + name)
        with zipfile.ZipFile(src) as zin, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
            for info in zin.infolist():
                data = zin.read(info.filename)
                if info.filename == "xl/_rels/workbook.xml.rels":
                    data = data.replace(
                        b"</Relationships>",
                        b'<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="styles.xml"/></Relationships>',
                    )
                zout.writestr(info.filename, data)
            zout.writestr(
                "xl/styles.xml",
                '<?xml version="1.0"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
                + "".join(
                    "<si>" + "".join(f'<x i="{k * 90_000 + j}"/>' for j in range(90_000)) + "</si>"
                    for k in range(junk // 90_000)
                ) + "</styleSheet>",
            )
        return out

    def test_xlsx_rels_cannot_exempt_styles_xml(self):
        # styles.xml is read as a whole tree by openpyxl; pointing a sharedStrings
        # relationship at it must not grant the streaming exemption.
        path = self._styles_exempt_xlsx("styles-exempt.xlsx", 2_160_000)
        with self.assertRaises(docread.DocReadError) as caught:
            docread._guard_ooxml(path)
        self.assertEqual(caught.exception.kind, "too_large")

    def test_xlsm_workbook_still_uses_relationship_exemption(self):
        make_large_sheet_xlsx(self.root / "big.xlsx", rows=75_000, cols=10, text=True)
        (self.root / "big.xlsx").rename(self.root / "big.xlsm")
        self.assertGreater(docread._guard_ooxml(self.root / "big.xlsm"), 40 * 1024 * 1024)

    def _rewrite_big_xlsx(self, name, edit):
        make_large_sheet_xlsx(self.root / name, rows=75_000, cols=10, text=True)
        src = self.root / name
        out = self.root / ("rw-" + name)
        with zipfile.ZipFile(src) as zin, zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zout:
            for info in zin.infolist():
                renamed, data = edit(info.filename, zin.read(info.filename))
                zout.writestr(renamed, data)
        return out

    def test_xlsx_renamed_workbook_part_decoy_rels_not_exempt(self):
        # Workbook lives at xl/wb.xml (per Content_Types / _rels/.rels); the decoy
        # xl/_rels/workbook.xml.rels must not grant the worksheet exemption.
        def edit(name, data):
            if name == "xl/workbook.xml":
                return "xl/wb.xml", data
            if name == "[Content_Types].xml":
                return name, data.replace(b"/xl/workbook.xml", b"/xl/wb.xml")
            if name == "_rels/.rels":
                return name, data.replace(b"xl/workbook.xml", b"xl/wb.xml")
            return name, data

        path = self._rewrite_big_xlsx("renamed-wb.xlsx", edit)
        with self.assertRaises(docread.DocReadError) as caught:
            docread._guard_ooxml(path)
        self.assertEqual(caught.exception.kind, "too_large")

    def _extra_rel_xlsx(self, name, rel_type):
        def edit(part, data):
            if part == "xl/_rels/workbook.xml.rels":
                extra = (
                    '<Relationship Id="rId9" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/%s" '
                    'Target="worksheets/sheet1.xml"/></Relationships>' % rel_type
                ).encode()
                return part, data.replace(b"</Relationships>", extra)
            return part, data

        return self._rewrite_big_xlsx(name, edit)

    def test_xlsx_part_with_second_chartsheet_rel_not_exempt(self):
        path = self._extra_rel_xlsx("two-rels-chart.xlsx", "chartsheet")
        with self.assertRaises(docread.DocReadError) as caught:
            docread._guard_ooxml(path)
        self.assertEqual(caught.exception.kind, "too_large")

    def test_xlsx_part_with_second_externallink_rel_not_exempt(self):
        path = self._extra_rel_xlsx("two-rels-ext.xlsx", "externalLink")
        with self.assertRaises(docread.DocReadError) as caught:
            docread._guard_ooxml(path)
        self.assertEqual(caught.exception.kind, "too_large")

    def test_xlsx_chartsheet_is_not_exempt(self):
        # A chartsheet relationship is not a worksheet: the part gets the 32 MiB cap.
        make_large_sheet_xlsx(
            self.root / "chartsheet.xlsx", rows=75_000, cols=10, text=True,
            relationship_type="chartsheet",
        )
        out = self.read("chartsheet.xlsx")
        self.assertFalse(out["ok"], out)
        self.assertEqual(out["error_kind"], "too_large")
        self.assertIn("XML 单文件上限", out["error"])

    def test_xlsx_large_sheets_are_truncated_not_rejected(self):
        # The 2M global element budget must not reject ordinary big sheets; each
        # is read to the 5000-row/output cap with a truncation warning instead.
        cases = [
            ("big-100k-10.xlsx", 100_000, 10, False),
            ("big-40k-30.xlsx", 40_000, 30, False),
            ("big-70k-10-text.xlsx", 70_000, 10, True),
        ]
        for name, rows, cols, text in cases:
            with self.subTest(name=name):
                make_large_sheet_xlsx(self.root / name, rows=rows, cols=cols, text=text)
                out = self.read(name)
                self.assertTrue(out["ok"], out)
                self.assertEqual(out["sheets"][0]["rows"], 5000)
                self.assertTrue(out["sheets"][0]["truncated"])
                self.assertTrue(
                    any("超过 5000 行" in warning for warning in out["warnings"]),
                    out["warnings"],
                )

    def test_xlsx_million_shared_strings_is_not_rejected(self):
        # A million unique strings is >2M XML elements but is streamed by the
        # readers; only the 32 MiB per-file cap may reject it.
        make_shared_strings_xlsx(self.root / "strings.xlsx")
        with zipfile.ZipFile(self.root / "strings.xlsx") as archive:
            info = archive.getinfo("xl/sharedStrings.xml")
        self.assertLess(info.file_size, 32 * 1024 * 1024)
        self.assertGreater(docread._guard_ooxml(self.root / "strings.xlsx"), 20 * 1024 * 1024)

    def test_xlsx_shared_strings_outside_si_garbage_is_rejected(self):
        # openpyxl only clears <si>; 2M <x/> siblings stay in its tree. The guard scans
        # sharedStrings like a worksheet and caps the si-external count at 100k.
        make_shared_strings_xlsx(
            self.root / "ss-garbage.xlsx", count=1, garbage=2_000_000,
        )
        with zipfile.ZipFile(self.root / "ss-garbage.xlsx") as archive:
            info = archive.getinfo("xl/sharedStrings.xml")
        self.assertLess(info.file_size, 32 * 1024 * 1024)
        with self.assertRaises(docread.DocReadError) as caught:
            docread._guard_ooxml(self.root / "ss-garbage.xlsx")
        self.assertEqual(caught.exception.kind, "too_large")
        self.assertIn("si 外元素", str(caught.exception))
        self.assertIn("100000", str(caught.exception))

    def test_xlsx_shared_strings_single_si_flood_is_rejected(self):
        make_shared_strings_xlsx(
            self.root / "ss-si.xlsx", count=0, si_flood=100_001,
        )
        with self.assertRaises(docread.DocReadError) as caught:
            docread._guard_ooxml(self.root / "ss-si.xlsx")
        self.assertEqual(caught.exception.kind, "too_large")
        self.assertIn("单个 si 内元素", str(caught.exception))
        self.assertIn("100000", str(caught.exception))

    def test_ooxml_rejects_single_oversized_tag(self):
        # Expat builds the whole attribute dict before the start callback, so a
        # 28 MiB single tag with 2.5M attributes must be refused before it is fed.
        make_wide_tag_docx(self.root / "wide-tag.docx")
        with zipfile.ZipFile(self.root / "wide-tag.docx") as archive:
            info = archive.getinfo("word/document.xml")
        self.assertGreater(info.file_size, 20 * 1024 * 1024)
        self.assertLess(info.file_size, 32 * 1024 * 1024)
        out = self.read("wide-tag.docx")
        self.assertFalse(out["ok"], out)
        self.assertEqual(out["error_kind"], "too_large")
        self.assertIn("4 MiB", out["error"])

    def test_ooxml_rejects_gt_value_tag_with_low_prescan_memory(self):
        # Every attribute value is ">"; a >-based counter resets at each one and
        # expat then builds the 2.5M-attribute dict. The < spacing must reject at 4 MiB
        # and the pre-scan process must stay under 100 MiB.
        make_gt_value_tag_docx(self.root / "gt-tag.docx")
        with zipfile.ZipFile(self.root / "gt-tag.docx") as archive:
            info = archive.getinfo("word/document.xml")
        self.assertGreater(info.file_size, 20 * 1024 * 1024)
        self.assertLess(info.file_size, 32 * 1024 * 1024)
        out = self.read("gt-tag.docx")
        self.assertFalse(out["ok"], out)
        self.assertEqual(out["error_kind"], "too_large")
        self.assertIn("4 MiB", out["error"])

        code = (
            "import importlib.util, resource, sys\n"
            "spec = importlib.util.spec_from_file_location('docread', sys.argv[1])\n"
            "module = importlib.util.module_from_spec(spec)\n"
            "spec.loader.exec_module(module)\n"
            "try:\n"
            "    module._guard_ooxml(sys.argv[2])\n"
            "except module.DocReadError as error:\n"
            "    print(error.kind)\n"
            "print(resource.getrusage(resource.RUSAGE_SELF).ru_maxrss)\n"
        )
        completed = subprocess.run(
            [
                sys.executable, "-c", code,
                str(ROOT / "runner/docread.py"), str(self.root / "gt-tag.docx"),
            ],
            capture_output=True, check=True,
        )
        lines = completed.stdout.decode("utf-8").strip().splitlines()
        self.assertEqual(lines[0], "too_large")
        peak = int(lines[-1])
        if sys.platform != "darwin":
            peak *= 1024
        self.assertLess(peak, 100 * 1024 * 1024, peak)

    def test_ooxml_rejects_single_oversized_text_node(self):
        make_long_text_node_docx(self.root / "long-text.docx")
        out = self.read("long-text.docx")
        self.assertFalse(out["ok"], out)
        self.assertEqual(out["error_kind"], "too_large")
        self.assertIn("文本节点", out["error"])
        self.assertIn("4 MiB", out["error"])

    def test_docx_with_xml_renamed_to_bin_is_rejected(self):
        # Not every XML part ends in .xml; the guard must sniff the member head.
        make_low_ratio_zip(
            self.root / "renamed.docx",
            [("word/document.bin", 40 * 1024 * 1024)],
        )
        out = self.read("renamed.docx")
        self.assertFalse(out["ok"], out)
        self.assertEqual(out["error_kind"], "too_large")
        self.assertIn("XML 单文件上限", out["error"])

    def test_docx_with_many_elements_renamed_to_bin_is_rejected(self):
        # The element budget also applies to a .bin part that is really XML.
        make_docx_many_elements(
            self.root / "elements-bin.docx", count=2_000_001, member="word/document.bin",
        )
        out = self.read("elements-bin.docx")
        self.assertFalse(out["ok"], out)
        self.assertEqual(out["error_kind"], "too_large")
        self.assertIn("XML 元素", out["error"])
        self.assertIn("2000000", out["error"])

    def test_utf16be_xml_without_bom_is_detected(self):
        # lxml parses UTF-16BE with an XML declaration and no BOM; the 64-byte head
        # has NULs beside every ASCII byte, so they must be dropped before the `<`.
        make_encoded_xml_docx(self.root / "utf16be.docx", "utf-16-be")
        with zipfile.ZipFile(self.root / "utf16be.docx") as archive:
            info = archive.getinfo("word/document.bin")
        self.assertGreater(info.file_size, 32 * 1024 * 1024)
        with self.assertRaises(docread.DocReadError) as caught:
            docread._guard_ooxml(self.root / "utf16be.docx")
        self.assertEqual(caught.exception.kind, "too_large")
        self.assertIn("XML 单文件上限", str(caught.exception))

    def test_utf32_xml_with_bom_is_detected(self):
        make_encoded_xml_docx(
            self.root / "utf32le.docx", "utf-32-le", bom=codecs.BOM_UTF32_LE,
        )
        with zipfile.ZipFile(self.root / "utf32le.docx") as archive:
            info = archive.getinfo("word/document.bin")
        self.assertGreater(info.file_size, 32 * 1024 * 1024)
        with self.assertRaises(docread.DocReadError) as caught:
            docread._guard_ooxml(self.root / "utf32le.docx")
        self.assertEqual(caught.exception.kind, "too_large")
        self.assertIn("XML 单文件上限", str(caught.exception))

    def test_docx_with_too_many_xml_elements_is_rejected(self):
        make_docx_many_elements(self.root / "elements.docx")
        out = self.read("elements.docx")
        self.assertFalse(out["ok"], out)
        self.assertEqual(out["error_kind"], "too_large")
        self.assertIn("XML 元素", out["error"])
        self.assertIn("2000000", out["error"])

    def test_xlsx_wide_row_is_rejected(self):
        make_wide_row_xlsx(self.root / "wide-row.xlsx", cells=16_385)
        out = self.read("wide-row.xlsx")
        self.assertFalse(out["ok"], out)
        self.assertEqual(out["error_kind"], "too_large")
        self.assertIn("16384", out["error"])
        self.assertIn("格", out["error"])

    def test_xlsx_out_of_row_elements_are_rejected(self):
        make_out_of_row_xlsx(self.root / "out-of-row.xlsx")
        out = self.read("out-of-row.xlsx")
        self.assertFalse(out["ok"], out)
        self.assertEqual(out["error_kind"], "too_large")
        self.assertIn("行外元素", out["error"])
        self.assertIn("100000", out["error"])

    def test_xlsx_single_row_element_flood_is_rejected(self):
        sheet = f"""<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<dimension ref="A1"/><sheetData><row r="1">{'<x/>' * 100_001}</row></sheetData></worksheet>"""
        write_single_sheet_xlsx(self.root / "row-flood.xlsx", sheet)
        out = self.read("row-flood.xlsx")
        self.assertFalse(out["ok"], out)
        self.assertEqual(out["error_kind"], "too_large")
        self.assertIn("单行元素", out["error"])
        self.assertIn("100000", out["error"])

    def test_xlsx_stdlib_caps_columns_at_200(self):
        make_wide_row_xlsx(self.root / "wide-cols.xlsx", cells=1000)
        sections, sheets = docread._xlsx_stdlib(self.root / "wide-cols.xlsx")
        self.assertEqual(sheets[0]["cols"], 200)
        self.assertTrue(sheets[0]["columns_truncated"])
        self.assertEqual(len(sections[0]["text"].splitlines()[0].split(" | ")), 200)
        out = self.read("wide-cols.xlsx")
        self.assertTrue(out["ok"], out)
        self.assertTrue(any("超过 200 列" in warning for warning in out["warnings"]))

    def test_xlsx_caps_rows_when_dimension_is_missing(self):
        make_many_rows_xlsx(self.root / "nodim.xlsx", rows=6000, dimension=False)
        out = self.read("nodim.xlsx")
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["sheets"][0]["rows"], 5000)
        self.assertTrue(out["sheets"][0]["truncated"])
        self.assertTrue(any("超过 5000 行" in warning for warning in out["warnings"]))

    def test_xlsx_stdlib_keeps_shared_strings_formulas_and_merges(self):
        sections, sheets = docread._xlsx_stdlib(self.root / "book.xlsx")
        self.assertEqual([sheet["name"] for sheet in sheets], ["汇总", "明细"])
        self.assertEqual(sheets[0]["formulas"], [{"cell": "B7", "formula": "=SUM(B2:B6)"}])
        self.assertEqual(sheets[0]["merged"], ["A1:B1"])
        self.assertIn("季度", sections[1]["text"])
        self.assertIn("备注", sections[1]["text"])

    def test_xlsx_stdlib_truncates_rows_and_warns(self):
        make_many_rows_xlsx(self.root / "many.xlsx", rows=70_000)
        sections, sheets = docread._xlsx_stdlib(self.root / "many.xlsx")
        self.assertEqual(sheets[0]["rows"], 5000)
        self.assertTrue(sheets[0]["truncated"])
        lines = sections[0]["text"].splitlines()
        self.assertEqual(len(lines), 5000)
        self.assertIn("项目5000", sections[0]["text"])
        self.assertNotIn("项目5001", sections[0]["text"])
        with mock.patch.object(docread, "_xlsx_openpyxl", side_effect=ImportError):
            out = self.read("many.xlsx")
        self.assertTrue(out["ok"], out)
        self.assertTrue(any("超过 5000 行" in warning for warning in out["warnings"]))

    # --- text cap ---------------------------------------------------------
    def test_text_is_capped_at_sixty_thousand_characters(self):
        big = self.root / "big.csv"
        big.write_text("列一,列二\n" + "".join(
            f"内容{i},{i}\n" for i in range(8000)), encoding="utf-8")
        out = docread.read_document("big.csv", root=self.root, max_chars=60000)
        self.assertTrue(out["ok"], out)
        self.assertLessEqual(len(out["text"]), 60000)
        self.assertTrue(out["truncated"])
        self.assertTrue(any("截断" in w for w in out["warnings"]))

    # --- negative paths ---------------------------------------------------
    def test_rejects_dotdot_escape(self):
        (pathlib.Path(self.tmp.name) / "secret.txt").write_text("secret", encoding="utf-8")
        out = self.read("../secret.txt")
        self.assertFalse(out["ok"])
        self.assertEqual(out["error_kind"], "path_denied")

    def test_rejects_absolute_etc_passwd(self):
        out = self.read("/etc/passwd")
        self.assertFalse(out["ok"])
        self.assertEqual(out["error_kind"], "path_denied")

    def test_rejects_home_ssh(self):
        out = self.read("~/.ssh/id_rsa")
        self.assertFalse(out["ok"])
        self.assertEqual(out["error_kind"], "path_denied")

    def test_rejects_symlink_file_escape(self):
        link = self.root / "link.pdf"
        link.symlink_to("/etc/passwd")
        out = self.read("link.pdf")
        self.assertFalse(out["ok"])
        self.assertEqual(out["error_kind"], "path_denied")

    def test_rejects_symlink_directory_escape(self):
        outside = pathlib.Path(self.tmp.name) / "outside"
        outside.mkdir()
        (outside / "x.pdf").write_bytes(b"%PDF-1.4")
        (self.root / "out").symlink_to(outside, target_is_directory=True)
        out = self.read("out/x.pdf")
        self.assertFalse(out["ok"])
        self.assertEqual(out["error_kind"], "path_denied")

    def test_rejects_missing_and_unsupported_and_oversize(self):
        self.assertEqual(self.read("nope.pdf")["error_kind"], "not_found")
        (self.root / "run.exe").write_bytes(b"MZ")
        self.assertEqual(self.read("run.exe")["error_kind"], "unsupported_type")
        (self.root / "big.csv").write_text("x" * 5000, encoding="utf-8")
        out = docread.read_document("big.csv", root=self.root, max_bytes=1000)
        self.assertFalse(out["ok"])
        self.assertEqual(out["error_kind"], "too_large")

    def test_rejects_directory_and_empty_path(self):
        self.assertEqual(self.read(".")["error_kind"], "invalid_path")
        self.assertEqual(self.read("")["error_kind"], "invalid_path")
        self.assertNotEqual(self.read("a\x00b.pdf")["ok"], True)

    def test_root_must_exist(self):
        out = docread.read_document("x.pdf", root=pathlib.Path(self.tmp.name) / "missing")
        self.assertFalse(out["ok"])
        self.assertEqual(out["error_kind"], "path_denied")

    def test_default_root_is_inputs_under_cwd(self):
        cwd = os.getcwd()
        os.chdir(self.tmp.name)
        try:
            out = docread.read_document("report.pdf")
        finally:
            os.chdir(cwd)
        self.assertTrue(out["ok"], out)
        self.assertEqual(out["filename"], "report.pdf")

    def test_old_xls_needs_xlrd_or_reports_corruption(self):
        (self.root / "old.xls").write_bytes(b"\xd0\xcf\x11\xe0\xa1\xb1\x1a\xe1")
        out = self.read("old.xls")
        self.assertFalse(out["ok"])
        self.assertIn(out["error_kind"], {"missing_library", "corrupted"})

    # --- CLI --------------------------------------------------------------
    def test_cli_returns_json_and_exit_code(self):
        proc = subprocess.run(
            [sys.executable, str(ROOT / "runner/docread.py"), "--path", "report.pdf",
             "--root", str(self.root), "--question", "第3页的金额", "--json"],
            capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(proc.returncode, 0, proc.stderr)
        out = json.loads(proc.stdout)
        self.assertTrue(out["ok"])
        self.assertEqual(out["hits"][0]["page"], 3)
        bad = subprocess.run(
            [sys.executable, str(ROOT / "runner/docread.py"), "--path", "../secret.txt",
             "--root", str(self.root), "--json"],
            capture_output=True, text=True, timeout=60,
        )
        self.assertEqual(bad.returncode, 2)
        self.assertFalse(json.loads(bad.stdout)["ok"])


if __name__ == "__main__":
    unittest.main()
