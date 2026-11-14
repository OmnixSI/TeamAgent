#!/usr/bin/env python3
"""Synthetic PDF/DOCX/XLSX for the read_document path. No user files touched.

Needs: reportlab (PDF, STSong-Light CID font) + openpyxl (XLSX). Use a temp
venv, e.g. python3.14 -m venv /tmp/x && pip install reportlab openpyxl.
"""
import os, pathlib, subprocess, sys, zipfile, html
OUT = pathlib.Path(sys.argv[1] if len(sys.argv) > 1 else "/tmp/ds-syn-docs")
OUT.mkdir(parents=True, exist_ok=True)
os.chmod(OUT, 0o700)

TITLE = "项目验收记录"
ROWS = [("语音识别", "张伟", "128", "7.42"), ("图片识别", "李娜", "35", "0.08"), ("文档读取", "王强", "12", "0.00")]

# PDF via reportlab + STSong-Light CID font (CJK)
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.cidfonts import UnicodeCIDFont
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib import colors
from reportlab.platypus import SimpleDocTemplate, Paragraph, Spacer, Table, TableStyle
pdfmetrics.registerFont(UnicodeCIDFont("STSong-Light"))
base = ParagraphStyle("body", fontName="STSong-Light", fontSize=12, leading=18)
head = ParagraphStyle("head", fontName="STSong-Light", fontSize=20, leading=26, spaceAfter=12)
pdf_path = OUT / "record.pdf"
doc = SimpleDocTemplate(str(pdf_path), pagesize=A4)
story = [Paragraph(TITLE, head),
         Paragraph("2026年11月14日，测试员核对本周能力。张伟负责语音识别，金额 7.42 元；李娜负责图片识别，金额 0.08 元。", base),
         Spacer(1, 12),
         Table([["能力", "负责人", "次数", "金额（元）"]] + [list(r) for r in ROWS],
               colWidths=[110, 90, 70, 100],
               style=TableStyle([("FONTNAME", (0,0), (-1,-1), "STSong-Light"),
                                 ("GRID", (0,0), (-1,-1), 0.8, colors.black),
                                 ("BACKGROUND", (0,0), (-1,0), colors.whitesmoke)])),
         Spacer(1, 12),
         Paragraph("结论：语音识别与图片识别已验收，文档读取待接线。", base)]
doc.build(story)
os.chmod(pdf_path, 0o600)

# Minimal DOCX (OOXML) with the same facts
W = "http://schemas.openxmlformats.org/wordprocessingml/2006/main"
paras = [TITLE] + [f"{a}：负责人 {b}，{c} 次，{d} 元。" for a,b,c,d in ROWS] + ["结论：语音识别与图片识别已验收，文档读取待接线。"]
body = "".join(f'<w:p><w:r><w:t xml:space="preserve">{html.escape(p)}</w:t></w:r></w:p>' for p in paras)
doc = f'<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="{W}"><w:body>{body}</w:body></w:document>'
docx_path = OUT / "record.docx"
with zipfile.ZipFile(docx_path, "w", zipfile.ZIP_DEFLATED) as z:
    z.writestr("[Content_Types].xml", '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>')
    z.writestr("_rels/.rels", '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>')
    z.writestr("word/document.xml", doc)
os.chmod(docx_path, 0o600)

# XLSX via openpyxl (runner venv)
from openpyxl import Workbook
wb = Workbook(); ws = wb.active; ws.title = "验收"
ws.append(["能力", "负责人", "次数", "金额（元）"])
for row in ROWS: ws.append(list(row))
ws.append(["合计", "", 175, 7.50])
xlsx_path = OUT / "record.xlsx"
wb.save(xlsx_path)
os.chmod(xlsx_path, 0o600)
print(str(OUT))
