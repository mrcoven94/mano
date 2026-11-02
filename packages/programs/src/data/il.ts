import type { StateCatalog } from "../types.js";

export const IL: StateCatalog = {
  "state": "IL",
  "programs": {
    "snap": {
      "state": "IL",
      "program": "snap",
      "name": {
        "value": "Supplemental Nutrition Assistance Program (SNAP)",
        "sourceUrl": "https://www.dhs.state.il.us/page.aspx?item=30357",
        "checkedAt": "2026-10-30",
        "quote": "The Supplemental Nutrition Assistance Program (SNAP) (formerly Food Stamps) helps low-income people and families"
      },
      "agency": {
        "value": "Illinois Department of Human Services (IDHS)",
        "sourceUrl": "https://www.dhs.state.il.us/page.aspx?item=30357",
        "checkedAt": "2026-10-30",
        "quote": "The Department of Human Services administers the program in Illinois."
      },
      "covers": {
        "value": "Monthly benefits on the Illinois Link Card to buy food and seeds or plants for growing food; not hot ready-to-eat food, vitamins, medicine, pet food, alcohol, tobacco or other nonfood items.",
        "sourceUrl": "https://www.dhs.state.il.us/page.aspx?item=30357",
        "checkedAt": "2026-10-30",
        "quote": "Benefits are provided on the Illinois Link Card - an electronic card that is accepted at most grocery stores."
      },
      "incomeLimit": {
        "value": {
          "year": "October 2026 issuances (IDHS Manual Release 26.26, dated 10/01/2026)",
          "basis": "Illinois broad-based categorical eligibility: 165% of the federal poverty level for households without a qualifying member, and 200% of the federal poverty level for households with a qualifying member (60 or older, or receiving a listed disability benefit). Households in which every person is authorized for TANF, GA or SSI do not have to meet a gross limit.",
          "period": "monthly",
          "measuredOn": "gross",
          "tables": [
            {
              "appliesTo": "households with no qualifying member, that is no member 60 or older and no member receiving SSI, Social Security disability or blindness benefits, AABD, a VA total disability rating or another disability benefit IDHS lists (165% FPL)",
              "when": [
                {
                  "elderlyOrDisabled": false
                }
              ],
              "bySize": [
                2195,
                2976,
                3757,
                4538,
                5319,
                6100,
                6881,
                7662,
                8443,
                9224
              ],
              "eachAdditional": 781
            },
            {
              "appliesTo": "households with a qualifying member: a member 60 or older (from the month they turn 60) or a member receiving SSI, Social Security disability or blindness benefits, AABD, a VA total disability rating or another disability benefit IDHS lists (200% FPL). Such a household with a higher gross income can still qualify by meeting the net income limit.",
              "when": [
                {
                  "elderlyOrDisabled": true
                }
              ],
              "bySize": [
                2660,
                3607,
                4554,
                5500,
                6447,
                7394,
                8340,
                9287,
                10234,
                11180
              ],
              "eachAdditional": 947
            }
          ]
        },
        "sourceUrl": "https://www.dhs.state.il.us/page.aspx?item=180098",
        "checkedAt": "2026-10-30",
        "quote": "The SNAP 200% FPL Gross Income Standards have increased and are used to determine categorical eligibility for qualifying member households."
      },
      "netIncomeLimit": {
        "value": {
          "year": "October 2026 issuances (IDHS Manual Release 26.26, dated 10/01/2026)",
          "basis": "100% of the federal poverty level. Per IDHS PM 13-01-01, a household with a qualifying member whose gross income is over the 200% limit can still qualify by meeting this net limit. Households with a member disqualified for an intentional program violation or sanctioned under a work rule must meet both the gross and the net limit; that group is defined by program status and is not encoded in when.",
          "period": "monthly",
          "measuredOn": "net",
          "tables": [
            {
              "appliesTo": "households with a qualifying member (60 or older, or receiving a listed disability benefit) whose gross income is over the 200% FPL limit; also households with a disqualified or sanctioned member, who must meet it in addition to the gross limit",
              "when": [
                {
                  "elderlyOrDisabled": true
                }
              ],
              "bySize": [
                1330,
                1804,
                2277,
                2750,
                3224,
                3697,
                4170,
                4644,
                5118,
                5592
              ],
              "eachAdditional": 474
            }
          ]
        },
        "sourceUrl": "https://www.dhs.state.il.us/page.aspx?item=180098",
        "checkedAt": "2026-10-30",
        "quote": "Federal law provides for an increase to the Maximum Monthly Gross (165% FPL) and Net Income Standards (100% FPL) effective with October 2026 issuances."
      },
      "renewal": {
        "value": "Most households renew every 6 months, with an interview at alternating renewals and a no-interview EZ REDE form in between; households in the elderly and disabled simplified project (every adult 60 or older or disabled, no earned income) renew every 24 months. IDHS mails the renewal form 60 days before the period ends.",
        "sourceUrl": "https://www.dhs.state.il.us/page.aspx?item=174483",
        "checkedAt": "2026-10-30",
        "quote": "All SNAP households, except those receiving SNAP under the Elderly and/or Disabled Simplified Redetermination Project (EDSRP), will be assigned 6-month certification periods."
      },
      "apply": {
        "value": "Apply online through ABE (Application for Benefits Eligibility) at abe.illinois.gov, by phone through the ABE Help Line at 1-800-843-6154, in person at a local IDHS Family Community Resource Center, or by carrying, mailing or faxing the paper application IL444-2378 B to that office. An interview follows, in person or by phone.",
        "sourceUrl": "https://www.dhs.state.il.us/page.aspx?item=33698",
        "checkedAt": "2026-10-30",
        "quote": "Use the Application for Benefits Eligibility (ABE) to apply for SNAP, cash or medical assistance - online, anytime."
      },
      "phone": {
        "value": "1-800-843-6154",
        "sourceUrl": "https://www.dhs.state.il.us/page.aspx?item=33698",
        "checkedAt": "2026-10-30",
        "quote": "Please call our toll-free line ABE Help Line at 1-800-843-6154 (Voice)"
      },
      "website": {
        "value": "https://abe.illinois.gov",
        "sourceUrl": "https://www.dhs.state.il.us/page.aspx?item=33412",
        "checkedAt": "2026-10-30",
        "quote": "Apply on-line at: www.abe.illinois.gov"
      },
      "gaps": [
        {
          "field": "incomeLimit",
          "reason": "The main IDHS SNAP page (item=30357) and the DHS 124 brochure still show October 2025 limits. The October 2026 tables here come from Manual Release 26.26, which publishes rows for sizes 1 to 10 and matches WAG 13-01-01-a. The qualifying member definition (60 or older, or receiving a listed disability benefit) is from PM 05-06-01 (item=13632), not the release page; someone with a disability but no listed benefit or VA rating may not count as a qualifying member."
        },
        {
          "field": "netIncomeLimit",
          "reason": "Households with a member disqualified for an intentional program violation or sanctioned under a work rule must also meet the net limit (PM 13-01-01); that group is a program status, so it is described in appliesTo but not encoded in when."
        }
      ]
    },
    "medicaid": {
      "state": "IL",
      "program": "medicaid",
      "name": {
        "value": "Illinois Medicaid",
        "sourceUrl": "https://hfs.illinois.gov/medicalclients/medicaidguide/apply.html",
        "checkedAt": "2026-10-30",
        "quote": "Eligibility for Illinois Medicaid is generally based on income, household size, and other factors."
      },
      "agency": {
        "value": "Illinois Department of Healthcare and Family Services (HFS)",
        "sourceUrl": "https://hfs.illinois.gov/medicalclients/medicalprograms.html",
        "checkedAt": "2026-10-30",
        "quote": "The Illinois Department of Healthcare and Family Services (HFS) is committed to improving the health of Illinois' families by providing access to quality healthcare."
      },
      "covers": {
        "value": "Health coverage that for most enrollees includes doctor visits, dental care, well-child care and immunizations, mental health and substance use services, hospital and emergency care, prescription drugs, and medical equipment and supplies; some programs cover a limited set of services.",
        "sourceUrl": "https://hfs.illinois.gov/medicalclients/medicalprograms.html",
        "checkedAt": "2026-10-30",
        "quote": "Most people who enroll are covered for comprehensive services, including, but not limited to; doctor visits and dental care, well-child care, immunizations for children"
      },
      "incomeLimit": {
        "value": {
          "year": "2026 (IDHS chart 2026 Family Health Plans Monthly Income Standards, WAG 25-03-02 (2))",
          "basis": "FamilyCare (parents and caretaker relatives) and ACA Adults (adults 19 to 64 under the Medicaid expansion): 138% of the federal poverty level on MAGI income. The chart's dollar amounts already include the 5% disregard.",
          "period": "monthly",
          "measuredOn": "magi",
          "tables": [
            {
              "appliesTo": "adults 19 to 64 (ACA Adults) and parents and caretaker relatives (FamilyCare)",
              "bySize": [
                1835,
                2488,
                3141,
                3795,
                4448,
                5101,
                5754,
                6407,
                7061,
                7714
              ],
              "eachAdditional": 652
            }
          ]
        },
        "sourceUrl": "https://www.dhs.state.il.us/page.aspx?item=21741",
        "checkedAt": "2026-10-30",
        "quote": "FamilyCare and ACA Adults MAGI - 138% FPL (includes 5% disregard) (Adults)"
      },
      "renewal": {
        "value": "Coverage is renewed every 12 months today; HFS mails a renewal letter and coverage ends if you do not respond. Starting with their first renewal in 2027, some ACA Adults will renew every 6 months and must meet or be exempt from new federal work requirements.",
        "sourceUrl": "https://hfs.illinois.gov/medicalclients/medicaidguide/hr1customernotices.html",
        "checkedAt": "2026-10-30",
        "quote": "will need to redetermine their eligibility every 6 months, instead of every 12 months as it is now."
      },
      "apply": {
        "value": "Apply online at abe.illinois.gov (the same application covers SNAP and cash), by phone through the DHS Help Line at 1-800-843-6154, in person at an IDHS Family Community Resource Center, or by carrying, mailing or faxing a paper application to that office.",
        "sourceUrl": "https://hfs.illinois.gov/medicalclients/medicaidguide/applying.html",
        "checkedAt": "2026-10-30",
        "quote": "There are four ways to apply for Medicaid:"
      },
      "phone": {
        "value": "1-800-843-6154",
        "sourceUrl": "https://hfs.illinois.gov/medicalclients/medicaidguide/applying.html",
        "checkedAt": "2026-10-30",
        "quote": "You can apply over the phone by calling the DHS Help Line at 1-800-843-6154."
      },
      "website": {
        "value": "https://abe.illinois.gov",
        "sourceUrl": "https://hfs.illinois.gov/medicalclients/medicaidguide/applying.html",
        "checkedAt": "2026-10-30",
        "quote": "You can apply online at https://abe.illinois.gov"
      },
      "gaps": [
        {
          "field": "phone",
          "reason": "The number given is the DHS Help Line for applying. HFS also lists a Health Benefits Hotline (1-866-468-7543 in Illinois) for questions about medical benefits and a renewal line (1-866-255-5437) on its HealthChoice renewal page."
        },
        {
          "field": "incomeLimit",
          "reason": "The chart publishes sizes 1 to 10 and +652 for each additional person, but its own size 8 to 9 step is 654 and 9 to 10 is 653, so applying +652 past size 10 may run a few dollars low. The HFS Medical Programs page still prints an older ACA Adults figure ($1,366 for one person). The chart is labeled 2026 with no end date; only the Family Assist column says Effective 10/01/2026."
        }
      ]
    },
    "liheap": {
      "state": "IL",
      "program": "liheap",
      "name": {
        "value": "Low Income Home Energy Assistance Program (LIHEAP)",
        "sourceUrl": "https://dceo.illinois.gov/communityservices/utilitybillassistance.html",
        "checkedAt": "2026-10-30",
        "quote": "The Low Income Home Energy Assistance Program (LIHEAP) helps eligible low-income households pay for home energy services (primarily heating during winter months)."
      },
      "agency": {
        "value": "Illinois Department of Commerce and Economic Opportunity (DCEO), Office of Community Assistance, through local administering agencies in each county",
        "sourceUrl": "https://dceo.illinois.gov/communityservices/homeweatherization/communityactionagencies/helpillinoisfamilies.html",
        "checkedAt": "2026-10-30",
        "quote": "Help Illinois Families is administered by DCEO’s Office of Community Assistance for the following federal programs: Low-Income Home Energy Assistance Program (LIHEAP)"
      },
      "covers": {
        "value": "Help paying home energy bills, mainly heating in winter: a one-time payment to the gas, electric or propane vendor (or a cash benefit for renters whose heat is in the rent), plus crisis help such as reconnection assistance while funds last.",
        "sourceUrl": "https://dceo.illinois.gov/communityservices/utilitybillassistance.html",
        "checkedAt": "2026-10-30",
        "quote": "helps eligible low-income households pay for home energy services (primarily heating during winter months)."
      },
      "incomeLimit": {
        "value": {
          "year": "Program Year 2027 (applications from October 1, 2026), based on 2026 federal poverty guidelines",
          "basis": "Combined gross household income for the 30 days before applying. Customers of Ameren Illinois, ComEd, Nicor Gas, North Shore Gas and Peoples Gas must be at or below 300% of the federal poverty guidelines; customers of other energy vendors must be at or below 60% of state median income. The state may adjust these levels based on federal funding.",
          "period": "monthly",
          "measuredOn": "gross",
          "tables": [
            {
              "appliesTo": "customers of Ameren Illinois, ComEd, Nicor Gas, North Shore Gas or Peoples Gas (300% of the federal poverty guidelines, 30 day income)",
              "bySize": [
                3990,
                5410,
                6830,
                8250,
                9670,
                11090,
                12510,
                13930
              ],
              "eachAdditional": null
            },
            {
              "appliesTo": "customers of any other utility or energy vendor (60% of state median income); the page names this limit but publishes no dollar amounts",
              "bySize": [],
              "eachAdditional": null
            }
          ]
        },
        "sourceUrl": "https://dceo.illinois.gov/communityservices/utilitybillassistance/howtoapply.html",
        "checkedAt": "2026-10-30",
        "quote": "2026 300% Federal Poverty Guidelines for 2027 Program Year"
      },
      "renewal": {
        "value": "No automatic renewal: LIHEAP pays a one-time benefit per program year, so a household applies again each program year; the 2027 program year takes applications from October 1, 2026 to August 13, 2027 or until funds run out.",
        "sourceUrl": "https://dceo.illinois.gov/communityservices/utilitybillassistance/faqs.html",
        "checkedAt": "2026-10-30",
        "quote": "LIHEAP provides a one-time benefit per Program Year to eligible customers."
      },
      "apply": {
        "value": "Submit the online Request for Services form at helpillinoisfamilies.com during your application month and wait for your county's local agency to contact you, or apply directly with the local agency. Adults 60 and older, people with disabilities, families with a child 5 or under and households facing disconnection could apply from October 1, 2026; everyone else from November 1, 2026.",
        "sourceUrl": "https://dceo.illinois.gov/communityservices/utilitybillassistance/howtoapply.html",
        "checkedAt": "2026-10-30",
        "quote": "Please visit helpillinoisfamilies.com during your application month to fill out and submit an online Request for Services form."
      },
      "phone": {
        "value": "1-833-711-0374",
        "sourceUrl": "https://dceo.illinois.gov/communityservices/utilitybillassistance.html",
        "checkedAt": "2026-10-30",
        "quote": "Or call Help Illinois Families call center at 1-833-711-0374."
      },
      "website": {
        "value": "https://dceo.illinois.gov/communityservices/homeweatherization/communityactionagencies/helpillinoisfamilies.html",
        "sourceUrl": "https://dceo.illinois.gov/communityservices/homeweatherization/communityactionagencies/helpillinoisfamilies.html",
        "checkedAt": "2026-10-30",
        "quote": "The Help Illinois Families’ online Request for Services form makes it easier to request information for assistance through the LIHEAP and/or CSBG programs."
      },
      "gaps": [
        {
          "field": "website",
          "reason": "https://helpillinoisfamilies.com and https://www.helpillinoisfamilies.com refused HTTPS connections when checked; http://helpillinoisfamilies.com redirected to the DCEO Help Illinois Families page used here, which links the Request for Services form."
        },
        {
          "field": "incomeLimit",
          "reason": "DCEO names a 60% of state median income limit for customers of other energy vendors but publishes no dollar amounts on this page, and the FY2027 LIHEAP state plan also gives only the percentage, so that table has bySize []. The 300% table stops at family size 8 and gives no per-person increment, so eachAdditional is null."
        }
      ]
    }
  },
  "documentedSites": [
    {
      "host": "dhs.state.il.us",
      "sourceUrl": "https://www.illinois.gov/agencies/agency.dhs.html",
      "checkedAt": "2026-10-30",
      "quote": "Illinois created DHS in 1997, to provide our state's residents with streamlined access to integrated services"
    },
    {
      "host": "helpillinoisfamilies.com",
      "sourceUrl": "https://dceo.illinois.gov/communityservices/utilitybillassistance/howtoapply.html",
      "checkedAt": "2026-10-30",
      "quote": "Please visit helpillinoisfamilies.com during your application month to fill out and submit an online Request for Services form."
    }
  ]
};
