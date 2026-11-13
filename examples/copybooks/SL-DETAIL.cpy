      * 同一レコード長（64 バイト）：明細  REC-TYPE = 'D'
       01  SL-DETAIL-REC.
           05  REC-TYPE            PIC X(1).
           05  STORE-CODE          PIC 9(4).
           05  SALES-DATE          PIC 9(8).
           05  CUST-ID             PIC 9(8).
           05  ITEM-NAME           PIC N(10).
           05  QTY                 PIC S9(4) COMP.
           05  AMOUNT              PIC S9(9) COMP-3.
           05  FILLER              PIC X(16).
