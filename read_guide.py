import pandas as pd

try:
    df = pd.read_excel('e:/Auto/Auto/Stock.xlsx', sheet_name='Guide')
    print(df.to_markdown())
except Exception as e:
    print(e)
