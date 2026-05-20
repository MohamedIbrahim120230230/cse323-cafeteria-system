import markdown
from xhtml2pdf import pisa
import os

files = [
    "Phase4_Testing_Pyramid.md",
    "Phase4_Playwright_Automation.md",
    "Phase4_Verification_Validation.md"
]

def convert_markdown_to_pdf(md_file, pdf_file):
    with open(md_file, 'r', encoding='utf-8') as f:
        md_text = f.read()
    
    html = markdown.markdown(md_text, extensions=['tables', 'fenced_code'])
    
    # Add some basic styling so tables and code blocks look okay
    styled_html = f"""
    <html>
    <head>
    <style>
        body {{ font-family: Helvetica, Arial, sans-serif; }}
        table {{ width: 100%; border-collapse: collapse; margin-bottom: 20px; }}
        th, td {{ border: 1px solid #ddd; padding: 8px; text-align: left; }}
        th {{ background-color: #f2f2f2; font-weight: bold; }}
        pre {{ background-color: #f8f8f8; padding: 10px; border: 1px solid #ddd; white-space: pre-wrap; font-family: Courier; font-size: 10px; }}
        code {{ font-family: Courier; background-color: #f8f8f8; padding: 2px 4px; border-radius: 4px; }}
        h1, h2, h3 {{ color: #333; }}
        hr {{ border: 0; border-top: 1px solid #eee; margin: 20px 0; }}
    </style>
    </head>
    <body>
        {html}
    </body>
    </html>
    """
    
    with open(pdf_file, "w+b") as result_file:
        pisa_status = pisa.CreatePDF(styled_html, dest=result_file)
        
    if pisa_status.err:
        print(f"Error converting {md_file} to PDF")
    else:
        print(f"Successfully created {pdf_file}")

for md_file in files:
    if os.path.exists(md_file):
        pdf_file = md_file.replace('.md', '.pdf')
        convert_markdown_to_pdf(md_file, pdf_file)
    else:
        print(f"File not found: {md_file}")
