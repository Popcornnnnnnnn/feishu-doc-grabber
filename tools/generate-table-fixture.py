#!/usr/bin/env python3

from pathlib import Path

from docx import Document
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Inches, Pt, RGBColor


ROOT = Path(__file__).resolve().parent.parent
OUTPUT = ROOT / "tests" / "generated" / "FG-02 Native Tables.docx"


def shade(cell, color):
    properties = cell._tc.get_or_add_tcPr()
    fill = OxmlElement("w:shd")
    fill.set(qn("w:fill"), color)
    properties.append(fill)


def clear_paragraph_border(paragraph_or_style):
    properties = paragraph_or_style._element.get_or_add_pPr()
    border = properties.find(qn("w:pBdr"))
    if border is not None:
        properties.remove(border)


def set_cell(cell, text, *, header=False, centered=False):
    cell.text = text
    cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
    paragraph = cell.paragraphs[0]
    paragraph.alignment = WD_ALIGN_PARAGRAPH.CENTER if centered else WD_ALIGN_PARAGRAPH.LEFT
    paragraph.paragraph_format.space_before = Pt(3)
    paragraph.paragraph_format.space_after = Pt(3)
    for run in paragraph.runs:
        run.font.name = "Arial Unicode MS"
        run._element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), "Arial Unicode MS")
        run.font.size = Pt(10)
        run.font.color.rgb = RGBColor(255, 255, 255) if header else RGBColor(0, 0, 0)
        run.bold = header
    if header:
        shade(cell, "1F4E78")


def style_table(table, widths=None):
    table.style = "Table Grid"
    table.autofit = False
    if widths:
        for row in table.rows:
            for index, width in enumerate(widths):
                row.cells[index].width = Inches(width)


doc = Document()
section = doc.sections[0]
section.page_width = Inches(8.5)
section.page_height = Inches(11)
section.top_margin = Inches(0.65)
section.bottom_margin = Inches(0.65)
section.left_margin = Inches(0.65)
section.right_margin = Inches(0.65)

for style_name in ["Title", "Heading 1", "Heading 2"]:
    style = doc.styles[style_name]
    style.font.name = "Arial Unicode MS"
    style.font.color.rgb = RGBColor(0, 0, 0)
    clear_paragraph_border(style)

title = doc.add_paragraph(style="Title")
title_run = title.add_run("FG 02 Native Tables")
title_run.font.name = "Arial Unicode MS"
title_run.font.color.rgb = RGBColor(0, 0, 0)
clear_paragraph_border(title)

intro = doc.add_paragraph(
    "This fixture verifies that Feishu import and export preserve native tables, empty cells, "
    "Unicode text, wide layouts, and merged cells."
)
intro.style = doc.styles["Normal"]

doc.add_heading("Basic and empty cells", level=1)
basic = doc.add_table(rows=5, cols=4)
style_table(basic, [1.55, 1.75, 1.75, 2.1])
basic_rows = [
    ["Key", "Value", "Unicode", "Notes"],
    ["TABLE-A1-8D31", "alpha", "Ελληνικά", "first sentinel"],
    ["empty-right", "", "naïve café", ""],
    ["symbols", "✓ ★", "Привет", "symbols © ™"],
    ["TABLE-END-91AF", "omega", "Grüße", "last basic row"],
]
for row_index, values in enumerate(basic_rows):
    for column_index, value in enumerate(values):
        set_cell(basic.cell(row_index, column_index), value, header=row_index == 0)

doc.add_heading("Wide table", level=1)
wide = doc.add_table(rows=3, cols=12)
style_table(wide, [0.6] * 12)
for column in range(12):
    set_cell(wide.cell(0, column), f"C{column + 1:02d}", header=True, centered=True)
    set_cell(wide.cell(1, column), f"WIDE-{column + 1:02d}", centered=True)
    set_cell(wide.cell(2, column), str((column + 1) * 10), centered=True)

doc.add_heading("Merged cells", level=1)
merged = doc.add_table(rows=5, cols=4)
style_table(merged, [1.8, 1.8, 1.8, 1.8])
for column, value in enumerate(["Region", "Quarter", "Metric", "Result"]):
    set_cell(merged.cell(0, column), value, header=True)

horizontal = merged.cell(1, 0).merge(merged.cell(1, 1))
set_cell(horizontal, "TABLE-MERGE-C7 horizontal", centered=True)
set_cell(merged.cell(1, 2), "Revenue")
set_cell(merged.cell(1, 3), "125")

vertical = merged.cell(2, 0).merge(merged.cell(3, 0))
set_cell(vertical, "Vertical merge", centered=True)
set_cell(merged.cell(2, 1), "Q1")
set_cell(merged.cell(2, 2), "Orders")
set_cell(merged.cell(2, 3), "42")
set_cell(merged.cell(3, 1), "Q2")
set_cell(merged.cell(3, 2), "Orders")
set_cell(merged.cell(3, 3), "57")

set_cell(merged.cell(4, 0), "Nested text")
cell = merged.cell(4, 1)
set_cell(cell, "line one")
paragraph = cell.add_paragraph("line two")
paragraph.paragraph_format.space_after = Pt(3)
set_cell(merged.cell(4, 2), "Blank next")
set_cell(merged.cell(4, 3), "")

doc.add_paragraph("TABLE-DOC-END-62F1")

OUTPUT.parent.mkdir(parents=True, exist_ok=True)
doc.save(OUTPUT)
print(OUTPUT)
