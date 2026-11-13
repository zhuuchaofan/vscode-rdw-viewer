      * 明細レコード（80 バイト）
       01  DETAIL-REC.
           05  REC-TYPE            PIC X(1).
           05  ORDER-NO            PIC 9(10).
           05  ORDER-DATE          PIC 9(8).
           05  ITEM-CODE           PIC X(10).
           05  ITEM-NAME           PIC X(20).
           05  AMOUNTS             USAGE COMP-3.
               10  QTY             PIC S9(5).
               10  UNIT-PRICE      PIC S9(7)V99.
               10  AMOUNT          PIC S9(9)V99.
           05  TAX-RATE            PIC 9V99.
           05  FILLER              PIC X(14).
