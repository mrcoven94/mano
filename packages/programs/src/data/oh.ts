import type { StateCatalog } from "../types.js";

export const OH: StateCatalog = {
  "state": "OH",
  "programs": {
    "snap": {
      "state": "OH",
      "program": "snap",
      "name": {
        "value": "Supplemental Nutrition Assistance Program (SNAP)",
        "sourceUrl": "https://benefits.ohio.gov/wps/portal/gov/obssp/home/resources/assistance-programs/01-snap",
        "checkedAt": "2026-10-30",
        "quote": "The Supplemental Nutrition Assistance Program (SNAP), helps people with low incomes buy healthy food."
      },
      "agency": {
        "value": "Ohio Department of Job and Family Services (applications are handled by county Job and Family Services offices)",
        "sourceUrl": "https://ohio.gov/residents/assistance-programs/food-assistance",
        "checkedAt": "2026-10-30",
        "quote": "Food Assistance - Ohio Department of Job and Family Services"
      },
      "covers": {
        "value": "Monthly benefits on the Ohio Direction Card (EBT) that people with low income use to buy groceries at approved stores and farm markets.",
        "sourceUrl": "https://benefits.ohio.gov/wps/portal/gov/obssp/home/resources/assistance-programs/01-snap",
        "checkedAt": "2026-10-30",
        "quote": "The Supplemental Nutrition Assistance Program (SNAP), helps people with low income buy healthy food."
      },
      "incomeLimit": {
        "value": {
          "year": "FY 2027 (October 1, 2026 Mass Change, Food Assistance Change Transmittal No. 112)",
          "basis": "The transmittal publishes gross income standards at 130% and 200% of poverty and a 165% separate assistance group standard, without saying who each applies to. Ohio Administrative Code 5101:4-2-02 (codes.ohio.gov) makes any assistance group with gross income at or below 200% that receives the Ohio careline notice categorically eligible, which waives the 130% gross limit, the net limit and the resource limit; 5101:4-6-29 sets the 165% test.",
          "period": "monthly",
          "measuredOn": "gross",
          "tables": [
            {
              "appliesTo": "assistance groups that are categorically eligible through Ohio careline (broad-based categorical eligibility); per OAC 5101:4-2-02 this covers groups with gross income at or below 200% of poverty, so it is the limit that applies to most households",
              "bySize": [
                2660,
                3607,
                4554,
                5500,
                6447,
                7394,
                8340,
                9287
              ],
              "eachAdditional": 947
            },
            {
              "appliesTo": "assistance groups that are not categorically eligible, for example when a member is disqualified for an intentional program violation or is otherwise excluded from categorical eligibility under OAC 5101:4-2-02(D)(2)",
              "bySize": [
                1729,
                2345,
                2960,
                3575,
                4191,
                4806,
                5421,
                6037
              ],
              "eachAdditional": 616
            }
          ]
        },
        "sourceUrl": "https://dam.assets.ohio.gov/image/upload/jfs.ohio.gov/EBS/Programs%20Rules%20and%20Resources/Food%20Assistance/Food%20Assistance%20Change%20Letters/2026/FACT_112_October_1_2026_Mass_Change.pdf",
        "checkedAt": "2026-10-30",
        "quote": "monthly gross income standards (130% and 200% of poverty), and monthly separate assistance group standards for elderly and disabled assistance groups only (165% of poverty)"
      },
      "netIncomeLimit": {
        "value": {
          "year": "FY 2027 (October 1, 2026 Mass Change, Food Assistance Change Transmittal No. 112)",
          "basis": "Net Income Standards at 100% of poverty from the transmittal. OAC 5101:4-2-02(C) waives the net income limit for categorically eligible assistance groups, so this test applies only to groups that are not categorically eligible.",
          "period": "monthly",
          "measuredOn": "net",
          "tables": [
            {
              "appliesTo": "assistance groups that are not categorically eligible (categorically eligible groups, including Ohio careline groups at or below 200% gross, have this limit waived)",
              "bySize": [
                1330,
                1804,
                2277,
                2750,
                3224,
                3697,
                4170,
                4644
              ],
              "eachAdditional": 474
            }
          ]
        },
        "sourceUrl": "https://dam.assets.ohio.gov/image/upload/jfs.ohio.gov/EBS/Programs%20Rules%20and%20Resources/Food%20Assistance/Food%20Assistance%20Change%20Letters/2026/FACT_112_October_1_2026_Mass_Change.pdf",
        "checkedAt": "2026-10-30",
        "quote": "Net Income Standards (100% of poverty)"
      },
      "renewal": {
        "value": "The county JFS office reviews eligibility and recertifies benefits every 4, 5, 6, 12 or 36 months depending on the household; households certified for 12 months also get an Interim Report to complete in the 5th month.",
        "sourceUrl": "https://benefits.ohio.gov/wps/portal/gov/obssp/home/resources/assistance-programs/01-snap",
        "checkedAt": "2026-10-30",
        "quote": "Every four, five, six, twelve, or thirty-six months, JFS will need to review your eligibility and recertify your benefits."
      },
      "apply": {
        "value": "Apply online through an Ohio Benefits account at ssp.benefits.ohio.gov, by phone at 844-640-6446, or by mailing, faxing or bringing the JFS 07200 application to the county JFS office. A telephone interview follows.",
        "sourceUrl": "https://benefits.ohio.gov/wps/portal/gov/obssp/home/resources/assistance-programs/01-snap",
        "checkedAt": "2026-10-30",
        "quote": "Online: Create or access your online account at ssp.benefits.ohio.gov. You can fill out applications for all programs using your online account."
      },
      "phone": {
        "value": "844-640-6446",
        "sourceUrl": "https://benefits.ohio.gov/wps/portal/gov/obssp/home/resources/assistance-programs/01-snap",
        "checkedAt": "2026-10-30",
        "quote": "Phone: Call 844-640-6446"
      },
      "website": {
        "value": "https://ssp.benefits.ohio.gov/",
        "sourceUrl": "https://benefits.ohio.gov/wps/portal/gov/obssp/home/resources/assistance-programs/01-snap",
        "checkedAt": "2026-10-30",
        "quote": "Online: Create or access your online account at ssp.benefits.ohio.gov."
      },
      "gaps": [
        {
          "field": "incomeLimit.tables",
          "reason": "The source also prints a 165% table for an elderly or disabled member who buys and cooks apart and is counted as a separate household. It is not a limit for the household applying, so it is left out."
        },
        {
          "field": "incomeLimit",
          "reason": "Not confirmed on an Ohio page: whether a household with a member 60 or older or disabled whose gross income is over 200% is exempt from the gross test and judged only on the 100% net test (the federal rule). The Ohio Benefits SNAP page says such households may be allowed up to 200%, but no fetched Ohio rule or transmittal states the exemption, so no table carries an elderlyOrDisabled condition. The Ohio Benefits SNAP page also still prints an older 130% chart (size 1: 1,632) that does not match the October 2026 transmittal."
        }
      ]
    },
    "medicaid": {
      "state": "OH",
      "program": "medicaid",
      "name": {
        "value": "Ohio Medicaid",
        "sourceUrl": "https://benefits.ohio.gov/wps/portal/gov/obssp/home/resources/assistance-programs/03-medicaid",
        "checkedAt": "2026-10-30",
        "quote": "Ohio Medicaid and related programs improve wellness and health outcomes by providing health care coverage for eligible individuals"
      },
      "agency": {
        "value": "Ohio Department of Medicaid (county Job and Family Services offices determine eligibility)",
        "sourceUrl": "https://medicaid.ohio.gov/families-and-individuals/coverage/who-qualifies",
        "checkedAt": "2026-10-30",
        "quote": "The Ohio Department of Medicaid (ODM) provides health care coverage to more than 3 million Ohioans"
      },
      "covers": {
        "value": "Health care coverage for eligible children, pregnant women, adults, older adults and people with disabilities, mostly through a Medicaid managed care plan.",
        "sourceUrl": "https://benefits.ohio.gov/wps/portal/gov/obssp/home/resources/assistance-programs/03-medicaid",
        "checkedAt": "2026-10-30",
        "quote": "providing health care coverage for eligible individuals, including children, pregnant women, adults, aged individuals, and individuals with disabilities."
      },
      "incomeLimit": {
        "value": {
          "year": "2026 (Medicaid Standards Help Sheet, effective 9/1/2026)",
          "basis": "MAGI Adult column, 133% FPL, which the sheet says is the highest standard for every category in the MAGI Adult group (young adults 19-20, non-disabled adults, parents and caretaker relatives, and others). The table does not include the 5% disregard; the sheet lists the 5% of FPL amount by size separately (67, 91, 114, 138, 162, 185, 209, 233, 256, 280, 304, 327) for MAGI groups when comparing income to the highest category. The sheet also prints a lower 90% Parent/Caretaker Relative column, not used here because parents also fall in the 133% MAGI Adult group.",
          "period": "monthly",
          "measuredOn": "magi",
          "tables": [
            {
              "appliesTo": "adults age 19 to 64 in the MAGI Adult group, including parents and caretaker relatives",
              "bySize": [
                1769,
                2399,
                3028,
                3658,
                4288,
                4917,
                5547,
                6176,
                6806,
                7435,
                8065,
                8694
              ],
              "eachAdditional": null
            }
          ]
        },
        "sourceUrl": "https://dam.assets.ohio.gov/image/upload/benefits.ohio.gov/2026_Medicaid_Standards_Help_Sheet_09012026.pdf",
        "checkedAt": "2026-10-30",
        "quote": "133% FPL denotes the highest FPL standard for all categories within the MAGI Adult coverage group"
      },
      "renewal": {
        "value": "Every 12 months the county JFS office tries to renew coverage automatically; if it cannot renew electronically, you may need to complete an annual Medicaid renewal form.",
        "sourceUrl": "https://benefits.ohio.gov/wps/portal/gov/obssp/home/resources/assistance-programs/03-medicaid",
        "checkedAt": "2026-10-30",
        "quote": "Every twelve months, the JFS will attempt to renew your benefits."
      },
      "apply": {
        "value": "Apply online through an Ohio Benefits account at ssp.benefits.ohio.gov, by phone at 844-640-6446, or with a paper application (ODM 07216 or JFS 07200) returned in person, by mail or by fax to the county JFS office.",
        "sourceUrl": "https://benefits.ohio.gov/wps/portal/gov/obssp/home/resources/assistance-programs/03-medicaid",
        "checkedAt": "2026-10-30",
        "quote": "Online: Create or access your online account at ssp.benefits.ohio.gov."
      },
      "phone": {
        "value": "1-800-324-8680",
        "sourceUrl": "https://medicaid.ohio.gov/home/contact-us",
        "checkedAt": "2026-10-30",
        "quote": "Call the Consumer Hotline 1-800-324-8680"
      },
      "website": {
        "value": "https://ssp.benefits.ohio.gov/",
        "sourceUrl": "https://benefits.ohio.gov/wps/portal/gov/obssp/home/resources/assistance-programs/03-medicaid",
        "checkedAt": "2026-10-30",
        "quote": "Online: Create or access your online account at ssp.benefits.ohio.gov."
      },
      "gaps": [
        {
          "field": "incomeLimit",
          "reason": "The help sheet stops at household size 12 and gives no per-person increment, so eachAdditional is null."
        }
      ]
    },
    "liheap": {
      "state": "OH",
      "program": "liheap",
      "name": {
        "value": "Home Energy Assistance Program (HEAP)",
        "sourceUrl": "https://www.occ.ohio.gov/factsheet/home-energy-assistance-program-heap",
        "checkedAt": "2026-10-30",
        "quote": "The Home Energy Assistance Program (HEAP), also known as"
      },
      "agency": {
        "value": "Ohio Department of Job and Family Services, Office of Community Support Services (moved from the Ohio Department of Development in 2026)",
        "sourceUrl": "https://www.occ.ohio.gov/factsheet/home-energy-assistance-program-heap",
        "checkedAt": "2026-10-30",
        "quote": "is a federally funded program administered by the Ohio Department of Job & Family Services, Office of Community Support Services"
      },
      "covers": {
        "value": "A once-per-winter credit applied directly to the household's main heating source (utility bill or bulk fuel) to help with heating costs; homeowners and renters can qualify.",
        "sourceUrl": "https://www.occ.ohio.gov/factsheet/home-energy-assistance-program-heap",
        "checkedAt": "2026-10-30",
        "quote": "Eligible households receive a one-time credit applied directly to their primary heating source (utility bill or bulk fuel) once per winter heating season."
      },
      "incomeLimit": {
        "value": {
          "year": "2026-2027",
          "basis": "175% of the federal poverty guidelines for households of 1 to 7 and 60% of State Median Income for 8 or more. The page prints these as two charts split only by household size, so they are combined here into one table in size order. Limits are the 12-month figures; the page also gives 30-day limits (size 1: 2,295.62) and says income is based on the last 30 days or 12 months, with wages of dependent minors under 18 excluded.",
          "period": "annual",
          "measuredOn": "unstated",
          "tables": [
            {
              "appliesTo": "all households (sizes 1 to 7 at 175% of poverty, sizes 8 to 12 at 60% of State Median Income)",
              "bySize": [
                27930,
                37870,
                47810,
                57750,
                67690,
                77630,
                87570,
                94881,
                96946,
                99010,
                101069,
                103132
              ],
              "eachAdditional": null
            }
          ]
        },
        "sourceUrl": "https://www.occ.ohio.gov/factsheet/home-energy-assistance-program-heap",
        "checkedAt": "2026-10-30",
        "quote": "at or below 175 percent of the federal income guidelines for households with up to seven people, and 60 percent of the State Median Income (SMI) for households of eight or more"
      },
      "renewal": {
        "value": "HEAP is paid once per winter heating season, so households apply again each season; applications for the 2026-2027 season are accepted from July 1, 2026 to May 31, 2027.",
        "sourceUrl": "https://www.occ.ohio.gov/factsheet/home-energy-assistance-program-heap",
        "checkedAt": "2026-10-30",
        "quote": "Applications for the current winter heating season are accepted beginning July 1, 2026, until May 31, 2027."
      },
      "apply": {
        "value": "Apply online at energyhelp.ohio.gov, by appointment with the local Energy Assistance Provider or Community Action Agency, or by mailing or dropping off a paper application there. Processing can take up to 12 weeks.",
        "sourceUrl": "https://www.occ.ohio.gov/factsheet/home-energy-assistance-program-heap",
        "checkedAt": "2026-10-30",
        "quote": "Consumers can apply online at www.energyhelp.ohio.gov or by scheduling an appointment with a local Energy Assistance Provider/Community Action Agency (EAP/CAA)."
      },
      "website": {
        "value": "https://www.energyhelp.ohio.gov",
        "sourceUrl": "https://www.occ.ohio.gov/factsheet/home-energy-assistance-program-heap",
        "checkedAt": "2026-10-30",
        "quote": "Consumers can apply online at www.energyhelp.ohio.gov"
      },
      "gaps": [
        {
          "field": "phone",
          "reason": "No statewide HEAP number found in fetchable text on an ODJFS page. jfs.ohio.gov HEAP and Winter Crisis pages render their content client-side and the fetched HTML has no program phone. aging.ohio.gov prints 1-800-282-0880 for energy assistance but credits the Ohio Department of Development, which no longer runs HEAP, so it may be stale. The OCC page only says to contact the local Energy Assistance Provider."
        },
        {
          "field": "incomeLimit",
          "reason": "The OCC page says total household income, not gross, so measuredOn is unstated. The 60% SMI chart stops at size 12 with no per-person increment, so eachAdditional is null. Earlier research found PUCO listing 29,930 for one person; 175% of the 2026 guideline (15,960) is 27,930, matching OCC."
        }
      ]
    }
  },
  "documentedSites": []
};
