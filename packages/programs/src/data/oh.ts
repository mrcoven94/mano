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
          "year": "FY2027 (Oct 1, 2026 to Sep 30, 2027)",
          "basis": "200% of the federal poverty level, Ohio's expanded (broad-based) categorical eligibility, in effect since October 1, 2024. The same transmittal also lists the 130% table (1729, 2345, 2960, 3575, 4191, 4806, 5421, 6037; each additional 616) and a 165% separate-group standard for elderly and disabled assistance groups.",
          "period": "monthly",
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
        "sourceUrl": "https://dam.assets.ohio.gov/image/upload/jfs.ohio.gov/EBS/Programs%20Rules%20and%20Resources/Food%20Assistance/Food%20Assistance%20Change%20Letters/2026/FACT_112_October_1_2026_Mass_Change.pdf",
        "checkedAt": "2026-10-30",
        "quote": "Gross Income Standards (200% of poverty)"
      },
      "netIncomeLimit": {
        "value": {
          "year": "FY2027 (Oct 1, 2026 to Sep 30, 2027)",
          "basis": "100% of the federal poverty level (Ohio Net Income Standards). The transmittal does not say in this table which assistance groups the net test applies to.",
          "period": "monthly",
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
      "gaps": []
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
          "year": "2026 (2026 federal poverty guidelines; same figures on the Medicaid Standards Help Sheet effective 9/1/2026)",
          "basis": "Adults age 19 to 64 (Ohio's Medicaid expansion adult group), 133% of the federal poverty level, monthly household income. Ohio's help sheet notes a 5% of poverty income deduction for MAGI groups when comparing income to the highest category.",
          "period": "monthly",
          "bySize": [
            1769,
            2399,
            3028,
            3658,
            4288,
            4917,
            5547,
            6176
          ],
          "eachAdditional": null
        },
        "sourceUrl": "https://dam.assets.ohio.gov/image/upload/medicaid.ohio.gov/Families%2C%20Individuals/Programs/whoQualifies/2026_Children_Families_Adults.pdf",
        "checkedAt": "2026-10-30",
        "quote": "2026 Monthly Financial Eligibility Children, Families, and Adults"
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
          "reason": "Partial: the 2026 Ohio Medicaid table lists household sizes 1 to 12 with no per-person increment, so eachAdditional is null; bySize gives sizes 1 to 8 from the Adults (age 19-64) column."
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
          "year": "2026-2027 program year",
          "basis": "175% of the federal poverty guidelines for households of 1 to 7; 60% of State Median Income for 8 or more (the size 8 figure is the 60% SMI limit). Total gross household income for the past 12 months; the same page also lists 30-day limits (1 person 2295.62).",
          "period": "annual",
          "bySize": [
            27930,
            37870,
            47810,
            57750,
            67690,
            77630,
            87570,
            94881
          ],
          "eachAdditional": null
        },
        "sourceUrl": "https://www.occ.ohio.gov/factsheet/home-energy-assistance-program-heap",
        "checkedAt": "2026-10-30",
        "quote": "2026-2027 175% Income Guidelines"
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
          "reason": "Partial: no fixed per-person increment above 8 (60% SMI table runs to size 12), so eachAdditional is null. PUCO's HEAP page lists $29,930 for a 1-person household, which conflicts with OCC's $27,930; 175% of the 2026 poverty guideline ($15,960) is $27,930, so the OCC figure is used. The ODJFS FY2027 LIHEAP plan PDF is inconsistent on whether 175% applies up to 7 or 8 people."
        }
      ]
    }
  },
  "documentedSites": []
};
