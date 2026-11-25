import subprocess
import os
import sys

def main():
    # Paths
    cwd = os.path.dirname(os.path.abspath(__file__))
    edge_path = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
    chrome_path = r"C:\Program Files\Google\Chrome\Application\chrome.exe"
    
    browser_path = None
    if os.path.exists(edge_path):
        browser_path = edge_path
        print("Found MS Edge.")
    elif os.path.exists(chrome_path):
        browser_path = chrome_path
        print("Found Google Chrome.")
    else:
        print("Error: Neither Microsoft Edge nor Google Chrome was found at standard paths.")
        sys.exit(1)
        
    html_path = os.path.join(cwd, "index.html")
    if not os.path.exists(html_path):
        print(f"Error: index.html not found in {cwd}")
        sys.exit(1)
        
    # Standard PDF Arguments
    # Note: --print-to-pdf-no-header disables page titles, URLs, and page numbers at the margin areas.
    
    # 1. Generate English PDF
    en_pdf = os.path.join(cwd, "Danat_Al_Mustaqbal_Proposal_EN.pdf")
    en_url = f"file:///{html_path.replace(os.sep, '/')}?lang=en&theme=light"
    
    try:
        if os.path.exists(en_pdf):
            with open(en_pdf, "r+"):
                pass
    except IOError:
        en_pdf = os.path.join(cwd, "Danat_Al_Mustaqbal_Proposal_EN_new.pdf")
        print(f"Warning: Default English PDF is locked. Saving to: {en_pdf}")
        
    print(f"Generating English PDF at: {en_pdf}")
    subprocess.run([
        browser_path,
        "--headless",
        "--disable-gpu",
        "--print-to-pdf-no-header",
        f"--print-to-pdf={en_pdf}",
        en_url
    ], check=True)
    print("English PDF generated successfully.")
    
    # 2. Generate Arabic PDF
    ar_pdf = os.path.join(cwd, "Danat_Al_Mustaqbal_Proposal_AR.pdf")
    ar_url = f"file:///{html_path.replace(os.sep, '/')}?lang=ar&theme=light"
    
    try:
        if os.path.exists(ar_pdf):
            with open(ar_pdf, "r+"):
                pass
    except IOError:
        ar_pdf = os.path.join(cwd, "Danat_Al_Mustaqbal_Proposal_AR_new.pdf")
        print(f"Warning: Default Arabic PDF is locked. Saving to: {ar_pdf}")
        
    print(f"Generating Arabic PDF at: {ar_pdf}")
    subprocess.run([
        browser_path,
        "--headless",
        "--disable-gpu",
        "--print-to-pdf-no-header",
        f"--print-to-pdf={ar_pdf}",
        ar_url
    ], check=True)
    print("Arabic PDF generated successfully.")

if __name__ == "__main__":
    main()
