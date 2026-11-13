      * トレーラーレコード（30 バイト）
       01  TRAILER-REC.
           05  REC-TYPE            PIC X(1).
           05  REC-COUNT           PIC 9(8).
           05  TOTAL-AMOUNT        PIC S9(11)V99 COMP-3.
           05  FILLER              PIC X(14).
