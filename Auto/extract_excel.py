import pandas as pd
import json

file_path = r'e:\Auto\شهر 6.xlsx'

try:
    xls = pd.ExcelFile(file_path)
    output = {}
    for sheet_name in xls.sheet_names:
        df = pd.read_excel(file_path, sheet_name=sheet_name)
        df = df.fillna("NULL_VALUE")
        output[sheet_name] = df.to_dict(orient='records')
        
    with open('excel_data.json', 'w', encoding='utf-8') as f:
        json.dump(output, f, ensure_ascii=False, indent=2, default=str)
    print("Successfully exported to excel_data.json")
except Exception as e:
    print(f"Error: {e}")
