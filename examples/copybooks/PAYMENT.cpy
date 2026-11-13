      * 支払レコード（56 バイト）
      * 支払区分 PAY-TYPE により PAY-CARD / PAY-BANK / PAY-CASH を切り替える
       01  PAYMENT-REC.
           05  PAY-NO              PIC 9(10).
           05  PAY-DATE            PIC 9(8).
           05  PAY-TYPE            PIC X(1).
               88  PAY-BY-CARD     VALUE 'C'.
               88  PAY-BY-BANK     VALUE 'B'.
               88  PAY-BY-CASH     VALUE 'K'.
           05  PAY-AMOUNT          PIC S9(9)V99 COMP-3.
           05  PAY-CARD.
               10  CARD-NO         PIC X(16).
               10  CARD-EXPIRE     PIC 9(4).
               10  CARD-HOLDER     PIC X(10).
           05  PAY-BANK REDEFINES PAY-CARD.
               10  BANK-CODE       PIC 9(4).
               10  BRANCH-CODE     PIC 9(3).
               10  ACCOUNT-TYPE    PIC X(1).
               10  ACCOUNT-NO      PIC 9(7).
               10  ACCOUNT-NAME    PIC X(15).
           05  PAY-CASH REDEFINES PAY-CARD.
               10  RECEIPT-NO      PIC X(12).
               10  CHANGE-AMOUNT   PIC S9(7) COMP-3.
               10  FILLER          PIC X(14).
           05  FILLER              PIC X(1).
