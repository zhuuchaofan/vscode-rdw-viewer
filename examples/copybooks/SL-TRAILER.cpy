      * 同一レコード長（64 バイト）：トレーラー  REC-TYPE = 'T'
       01  SL-TRAILER-REC.
           05  REC-TYPE            PIC X(1).
           05  REC-COUNT           PIC 9(8).
           05  TOTAL-AMOUNT        PIC S9(13) COMP-3.
           05  FILLER              PIC X(48).
