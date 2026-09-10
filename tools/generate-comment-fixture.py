#!/usr/bin/env python3

from pathlib import Path

from docx import Document
from docx.oxml.ns import qn
from docx.shared import Inches, RGBColor


ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "tests" / "generated" / "FG-07 Native Comments.docx"


def black_style(doc, style_name):
    style = doc.styles[style_name]
    style.font.color.rgb = RGBColor(0, 0, 0)
    border = style._element.get_or_add_pPr().find(qn("w:pBdr"))
    if border is not None:
        style._element.get_or_add_pPr().remove(border)


doc = Document()
section = doc.sections[0]
section.page_width = Inches(8.5)
section.page_height = Inches(11)
section.top_margin = Inches(0.8)
section.bottom_margin = Inches(0.8)
section.left_margin = Inches(0.85)
section.right_margin = Inches(0.85)

for name in ["Title", "Heading 1", "Heading 2"]:
    black_style(doc, name)

title = doc.add_paragraph(style="Title")
title.add_run("FG 07 Native Comments")
title_border = title._element.get_or_add_pPr().find(qn("w:pBdr"))
if title_border is not None:
    title._element.get_or_add_pPr().remove(title_border)

doc.add_paragraph(
    "This fixture provides stable body markers. Feishu-native whole-document comments are added after import."
)

doc.add_heading("First comment marker", level=1)
paragraph = doc.add_paragraph()
paragraph.add_run("COMMENT-ANCHOR-A3 covers this complete sentence for the first review thread.")

doc.add_heading("Second comment marker", level=1)
inline = doc.add_paragraph()
inline.add_run(
    "The second marker appears inside this sentence: COMMENT-ANCHOR-B7—its surrounding words verify body order."
)

doc.add_heading("Unicode comment marker", level=1)
unicode_paragraph = doc.add_paragraph()
unicode_paragraph.add_run("COMMENT-RESOLVED-C4 is the third independent body marker.")

doc.add_paragraph("Final sentinel: COMMENT-END-E119")

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
doc.save(OUTPUT)
print(OUTPUT)
