      * 同一レコード長（64 バイト）：ヘッダー  REC-TYPE = 'H'
       01  SL-HEADER-REC.
           05  REC-TYPE            PIC X(1).
           05  FILE-ID             PIC X(10).
           05  BUSINESS-DATE       PIC 9(8).
           05  FILLER              PIC X(45).
